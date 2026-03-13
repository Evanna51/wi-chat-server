const { GoogleAuth } = require("google-auth-library");
const config = require("../config");

let authClient = null;

async function getAccessToken() {
  if (!config.fcmProjectId || !config.fcmServiceAccountPath) {
    throw new Error("FCM config missing: FCM_PROJECT_ID / FCM_SERVICE_ACCOUNT_PATH");
  }
  if (!authClient) {
    authClient = new GoogleAuth({
      keyFile: config.fcmServiceAccountPath,
      scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
    });
  }
  const client = await authClient.getClient();
  const token = await client.getAccessToken();
  if (!token?.token) throw new Error("Failed to get Google access token");
  return token.token;
}

async function sendFcmMessage(deviceToken, payload) {
  const accessToken = await getAccessToken();
  const url = `https://fcm.googleapis.com/v1/projects/${config.fcmProjectId}/messages:send`;
  const body = {
    message: {
      token: deviceToken,
      notification: {
        title: payload.title || "人物来消息了",
        body: payload.body || "",
      },
      data: payload.data || {},
      android: {
        priority: "high",
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FCM send failed: ${res.status} ${text}`);
  }
  return text;
}

module.exports = { sendFcmMessage };
