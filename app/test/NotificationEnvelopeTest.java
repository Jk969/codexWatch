package top.jingxixi.codexwatch;
import org.json.JSONObject;

public class NotificationEnvelopeTest {
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    public static void main(String[] args) throws Exception {
        String[] levels = {"done", "error", "ask"};
        for (String level : levels) {
            String notify = "{\"t\":\"notify\",\"d\":{\"title\":\"任务提醒\",\"body\":\"中文内容\",\"chatId\":\"chat\",\"nid\":\"chat:turn\",\"level\":\"" + level + "\"}}";
            JSONObject direct = NotificationEnvelope.decode(notify);
            check(direct != null && "中文内容".equals(direct.getString("body")), "顶层通知");
            JSONObject live = NotificationEnvelope.decode("{\"t\":\"dev_frame\",\"deviceId\":\"pc\",\"d\":" + notify + "}");
            check(live != null && "pc".equals(live.getString("deviceId")), "实时封装通知");
            check("chat:turn".equals(live.getString("nid")), "事件 ID 不能按整数丢弃");
            check(NotificationEnvelope.decode("{\"queued\":true,\"t\":\"notify\",\"d\":{\"title\":\"离线提醒\"}}") != null, "离线补发");
        }
        check(NotificationEnvelope.decode("{\"t\":\"dev_frame\",\"d\":{\"t\":\"item\"}}") == null, "普通消息不通知");
        check(NotificationEnvelope.decode("{\"t\":\"notify\",\"d\":{\"body\":\"没有标题\"}}") == null, "缺标题不通知");
        check(NotificationEnvelope.decode("broken") == null, "畸形消息安全忽略");
        check(NotificationEnvelope.decode("{\"t\":\"dev_frame\",\"d\":null}") == null, "空封装");
        System.out.println("Notification envelope tests passed");
    }
}
