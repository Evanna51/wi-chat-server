# chatbox-Android 离线对话同步集成指南

> 服务端契约见仓库 [`docs/offline-sync-plan.md`](./offline-sync-plan.md) 与 [`README.md` § Sync API](../README.md#10-sync-api-offline-batch-drain)。
> 本文给 chatbox-Android 工程师看，描述 phone 端怎么对接 `POST /api/sync/push` 完成"户外离线缓存 → 回家批量补齐"。

---

## 1. 架构概述

用户在户外（不在家中 WiFi 下）时 Android 客户端无法访问 wi-chat-server，对话堆在手机本地。回到家后 phone 把本地 `synced=0` 的 turns 批量推回 server，server 端 `INSERT OR IGNORE`（PK 是 client-generated UUID v7）保证 N 次推送 = 1 次落库。

```
   ┌────────────┐                  ┌─────────────────────┐
   │  Android   │  user/assistant  │ Local Room/SQLite   │
   │  chatbox   │ ───────────────▶ │ pending_sync_turns  │
   │            │                  │ synced=0            │
   └─────┬──────┘                  └──────────┬──────────┘
         │                                    │ WorkManager / Network callback
         │                                    │ + 手动按钮
         │                                    ▼
         │                         ┌──────────────────────┐
         └────── 在线时实时         │  Drain queue         │
                /api/report-       │  POST /api/sync/push │
                interaction        │  (batch ≤ 100)       │
                                   └──────────┬───────────┘
                                              │ 200 OK + details
                                              ▼
                                   ┌──────────────────────┐
                                   │  wi-chat-server      │
                                   │  conversation_turns  │
                                   │  + memory_items      │
                                   │  + outbox indexer    │
                                   └──────────────────────┘
```

关键不变量：
- **client-generated UUID v7** 是 turn 主键，phone 一旦写本地就生成，永不变。
- 同 id 重复 push → server 返回 `skipped: already_exists`，**不重复**。
- phone 不需要本地复制 server 记忆/向量，记忆检索仍走 `/api/tool/memory-context`。
- 不需要 vector clock / CRDT / 双向 diff。

---

## 2. 本地表结构

### Room 注解（推荐）

```kotlin
@Entity(tableName = "pending_sync_turns")
data class PendingSyncTurn(
    @PrimaryKey val id: String,            // UUID v7, client-generated
    val assistantId: String,
    val sessionId: String,
    val role: String,                      // "user" | "assistant"
    val content: String,
    val createdAt: Long,                   // ms epoch, phone 本地时钟
    val synced: Int = 0,                   // 0 = pending, 1 = synced
    val syncAttempts: Int = 0,
    val lastAttemptAt: Long? = null,
    val lastError: String? = null,
)

@Dao
interface PendingSyncDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(turn: PendingSyncTurn)

    @Query("SELECT * FROM pending_sync_turns WHERE synced = 0 AND syncAttempts < :maxAttempts ORDER BY createdAt ASC LIMIT :limit")
    suspend fun pendingBatch(maxAttempts: Int = 5, limit: Int = 100): List<PendingSyncTurn>

    @Query("UPDATE pending_sync_turns SET synced = 1 WHERE id IN (:ids)")
    suspend fun markSynced(ids: List<String>)

    @Query("UPDATE pending_sync_turns SET syncAttempts = syncAttempts + 1, lastAttemptAt = :ts, lastError = :err WHERE id IN (:ids)")
    suspend fun markFailed(ids: List<String>, ts: Long, err: String)
}
```

### 等价 SQL DDL

```sql
CREATE TABLE IF NOT EXISTS pending_sync_turns (
  id TEXT PRIMARY KEY,
  assistantId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  synced INTEGER NOT NULL DEFAULT 0,
  syncAttempts INTEGER NOT NULL DEFAULT 0,
  lastAttemptAt INTEGER,
  lastError TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_sync_turns_synced
  ON pending_sync_turns(synced, createdAt);
```

> 也可以**复用**已有的 chat 表，只需加 `synced` / `syncAttempts` / `lastAttemptAt` 三列。Room migration 比另起一张表轻。

---

## 3. UUID v7 生成

Java/Kotlin 标准库没有 v7，推荐第三方：

```kotlin
// build.gradle (app)
dependencies {
    implementation("com.github.f4b6a3:uuid-creator:5.3.7")
}
```

```kotlin
import com.github.f4b6a3.uuid.UuidCreator

object TurnIdFactory {
    fun next(): String = UuidCreator.getTimeOrderedEpoch().toString()  // RFC 9562 v7
}
```

UUID v7 前 48 bit 是毫秒时间戳，天然有序，server 端按 createdAt ASC 排序时也跟 id 字典序一致，对 memory_edges 时序友好。

如果不想引依赖，自己手搓：48-bit ms timestamp + 12-bit rand + 62-bit rand + 2-bit version/variant，本质上拼一个 UUID 字符串。

---

## 4. 同步触发器（三层兜底）

```
1. 实时（在线时）           → 每条对话产生立即 try POST /api/sync/push（单条 batch）
2. 进入家中 WiFi 自动        → ConnectivityManager.NetworkCallback + GET /api/health 探活
3. 每天定时 1 次             → WorkManager PeriodicWorkRequest（兜底 drain）
4. 用户手动按钮              → "立即同步" UI 入口
```

### 4.1 WorkManager 周期任务

```kotlin
class SyncDrainWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        return try {
            SyncQueueDrainer.drain(applicationContext)
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }
}

object SyncScheduler {
    fun schedulePeriodic(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val request = PeriodicWorkRequestBuilder<SyncDrainWorker>(1, TimeUnit.DAYS)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(
                "sync-drain-daily",
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
    }
}
```

### 4.2 入网即触发

```kotlin
class HomeWifiCallback(
    private val context: Context,
) : ConnectivityManager.NetworkCallback() {

    override fun onAvailable(network: Network) {
        // 进入任意网络都先探活一次
        CoroutineScope(Dispatchers.IO).launch {
            if (probeServerReachable()) {
                SyncQueueDrainer.drain(context)
            }
        }
    }

    private suspend fun probeServerReachable(): Boolean = try {
        val client = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .build()
        val req = Request.Builder().url("$BASE_URL/api/health").get().build()
        client.newCall(req).execute().use { it.isSuccessful }
    } catch (_: Exception) { false }
}
```

注册一次（在 Application.onCreate）：
```kotlin
val cm = getSystemService(ConnectivityManager::class.java)
cm.registerDefaultNetworkCallback(HomeWifiCallback(applicationContext))
```

> 不用 SSID 检测：免定位权限，且对热点切换更鲁棒。直接探活 `/api/health` 就知道家中服务是否可达。

---

## 5. 同步流程伪代码（Kotlin 风格）

```kotlin
object SyncQueueDrainer {

    private const val BATCH_SIZE = 100
    private const val MAX_ATTEMPTS = 5

    suspend fun drain(context: Context) = withContext(Dispatchers.IO) {
        val dao = AppDatabase.get(context).pendingSyncDao()
        val deviceId = DeviceIdProvider.get(context)   // e.g. "android-${ANDROID_ID}"

        while (true) {
            val pending = dao.pendingBatch(maxAttempts = MAX_ATTEMPTS, limit = BATCH_SIZE)
            if (pending.isEmpty()) break

            val payload = SyncPushRequest(
                deviceId = deviceId,
                turns = pending.map { it.toSyncTurnDto() }
            )

            val resp = try {
                ChatServerApi.syncPush(payload)        // OkHttp/Retrofit, 5s timeout
            } catch (e: SocketTimeoutException) {
                dao.markFailed(pending.map { it.id }, System.currentTimeMillis(), "timeout")
                break                                   // 整批失败，下次再试
            } catch (e: HttpException) {
                if (e.code() in 400..499) {
                    // 4xx：payload 问题，写日志告警，但不死循环重试
                    dao.markFailed(pending.map { it.id }, System.currentTimeMillis(), "4xx:${e.code()}")
                    Log.e("Sync", "4xx from server: ${e.message()}")
                    break
                }
                // 5xx：交给 WorkManager 退避重试
                throw e
            }

            // 解析 details，accepted + skipped 都标记为 synced=1
            val syncedIds = resp.details
                .filter { it.status == "accepted" || it.status == "skipped" }
                .map { it.id }
            if (syncedIds.isNotEmpty()) dao.markSynced(syncedIds)

            val rejectedIds = resp.details
                .filter { it.status == "rejected" }
                .map { it.id }
            if (rejectedIds.isNotEmpty()) {
                dao.markFailed(rejectedIds, System.currentTimeMillis(), "rejected")
                // syncAttempts ≥ MAX_ATTEMPTS 的会被 pendingBatch 自动跳过
            }

            if (pending.size < BATCH_SIZE) break
        }
    }
}
```

DTO：
```kotlin
@Serializable data class SyncTurnDto(
    val id: String,
    val assistantId: String,
    val sessionId: String,
    val role: String,
    val content: String,
    val createdAt: Long,
)
@Serializable data class SyncPushRequest(val deviceId: String, val turns: List<SyncTurnDto>)
@Serializable data class SyncPushDetail(val id: String, val status: String, val reason: String? = null)
@Serializable data class SyncPushResponse(
    val ok: Boolean,
    val deviceId: String? = null,
    val accepted: Int = 0,
    val skipped: Int = 0,
    val rejected: Int = 0,
    val details: List<SyncPushDetail> = emptyList(),
)
```

---

## 6. 错误处理矩阵

| 场景 | server 表现 | phone 处理 |
|------|------------|-----------|
| 网络超时（连接 / 读取） | — | 整批失败，下次 WorkManager 重试，不动 `synced` |
| `401 unauthorized` | `{ok:false}` | 不重试，弹通知"API key 过期"，需用户配置 |
| `400 bad request`（zod 校验失败） | `{ok:false, error}` | 写日志告警；脏数据 + `syncAttempts++`，达上限 5 次后停止重试，写诊断日志 |
| `500 internal error` | `{ok:false}` | WorkManager 退避重试（30s → 1min → 2min ...） |
| 单条 `details[i].status == "rejected"` | 200 OK，整批接受 | 该条 `syncAttempts++`；其它继续 `synced=1` |
| 单条 `reason: "clock_corrected"` | 200 OK，状态仍 accepted | 当作 accepted 处理；可选记日志提醒"手机时钟可能偏离" |
| 重复推送（同 id） | 200 OK，details 里 `skipped: already_exists` | 视同成功，`synced=1` |
| `turns.length > 200` | 400 | phone 端必须切批；正常逻辑下不该触发，触发即 phone bug |

**指数退避**：依赖 WorkManager `BackoffPolicy.EXPONENTIAL`，初始 30s，封顶 5 次（约 30s + 1min + 2min + 4min + 8min ≈ 16min 后放弃）。每天定时任务会重新尝试。

---

## 7. 完整 cURL 示例

### 7.1 push（在线设备 drain 一条 turn）

```bash
TURN_ID=$(uuidgen | tr A-Z a-z)   # 真实 phone 用 UUID v7，这里仅 demo
TS=$(date +%s000)

curl -sS -X POST "http://192.168.5.7:8787/api/sync/push" \
  -H "x-api-key: dev-local-key" \
  -H "content-type: application/json" \
  --data "{
    \"deviceId\": \"android-001\",
    \"turns\": [{
      \"id\": \"$TURN_ID\",
      \"assistantId\": \"assistant_demo\",
      \"sessionId\": \"android-001-s1\",
      \"role\": \"user\",
      \"content\": \"户外离线攒的消息\",
      \"createdAt\": $TS
    }]
  }"
```

期望 response：`{"ok":true,"deviceId":"android-001","accepted":1,"skipped":0,"rejected":0,"details":[{"id":"...","status":"accepted"}]}`

第二次同 payload 再 push：`{"accepted":0,"skipped":1,...,"details":[{"id":"...","status":"skipped","reason":"already_exists"}]}`。

### 7.2 state（自检）

```bash
curl -sS "http://192.168.5.7:8787/api/sync/state?assistantId=assistant_demo&deviceId=android-001" \
  -H "x-api-key: dev-local-key"
```

response：
```json
{
  "ok": true,
  "now": 1777200000000,
  "assistantId": "assistant_demo",
  "deviceId": "android-001",
  "assistantTurnCount": 1234,
  "totalTurnCount": 5678,
  "lastTurnAt": 1777199000000
}
```

phone 端可以拿 `assistantTurnCount` 和本地 `synced=1` 行数对比，做"理论一致性"校验，发现 drift 时弹诊断 UI。

### 7.3 pull（拉 server 在 phone 离线期间生成的 proactive 消息）

复用现有接口：

```bash
curl -sS "http://192.168.5.7:8787/api/pull-messages?userId=default-user&since=0&limit=20" \
  -H "x-api-key: dev-local-key"
```

服务端契约见 README §5/§6。

---

## 8. session_id 命名规范

为避免多设备同 user 撞 session：

```kotlin
fun newSessionId(): String {
    val uuid = UuidCreator.getTimeOrderedEpoch().toString()
    return "${DeviceIdProvider.get()}-${uuid.take(8)}"
}
```

server 端不强约束 session_id 唯一，但同一 session_id 在两台手机上会让 turns 混到一起，记忆抽取虽然不会出错，但 UI 排序会乱。phone 端需要在每次新对话开启时按上面规则生成。

---

## 9. 不需要做的

- **本地复制 server 的记忆/向量**：phone 不存 `memory_items`，记忆检索继续实时调 `POST /api/tool/memory-context`。
- **本地实现记忆检索**：放弃，CPU/电量不划算。
- **双向 diff / vector clock**：UUID v7 + INSERT OR IGNORE 已无冲突。
- **历史 backfill**：phone 短期内不会有十年存量，不规划。

---

## 10. 自测清单

- [ ] 关闭网络 → 产生 5 条对话 → 本地表 `synced=0` 行数 +5
- [ ] 打开 WiFi → 入网回调触发 → drain 后 `synced=1` 行数 +5
- [ ] 同一台机器再次 drain → server 返回 `skipped=5`，本地无变化
- [ ] 杀掉服务进程 → drain 整批失败 → `synced=0` 不变 → 下次 WorkManager 重试
- [ ] phone 时钟手动调到 1970 → push 后 server 返回 `details[].reason == "clock_corrected"`，turn 仍 `synced=1`
- [ ] `GET /api/sync/state` 返回的 `assistantTurnCount` 与本地 `SELECT COUNT(*) FROM pending_sync_turns WHERE synced=1 AND assistantId=?` 一致

---

## 11. 联系

- 服务端 owner：见 `README.md`
- 设计文档：`docs/offline-sync-plan.md`
- 服务端测试工具：`npm run sync:replay -- --mode test --assistant <id> --count N`（一键端到端，可作 reference 实现）
