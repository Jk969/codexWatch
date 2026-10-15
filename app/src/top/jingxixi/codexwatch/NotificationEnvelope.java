package top.jingxixi.codexwatch;

import org.json.JSONObject;

/** 同时解析实时中继封装和离线补发；通知处理不依赖 WebView 生命周期。 */
final class NotificationEnvelope {
    static JSONObject decode(String message) {
        try {
            JSONObject frame = new JSONObject(message);
            String device = frame.optString("deviceId", "");
            if ("dev_frame".equals(frame.optString("t"))) {
                frame = frame.optJSONObject("d");
            }
            if (frame == null || !"notify".equals(frame.optString("t"))) return null;
            JSONObject data = frame.optJSONObject("d");
            if (data == null || data.optString("title", "").length() == 0) return null;
            JSONObject copy = new JSONObject(data.toString());
            copy.put("deviceId", device);
            return copy;
        } catch (Throwable ignored) {
            return null;
        }
    }
}
