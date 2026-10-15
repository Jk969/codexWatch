import java.net.URI;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;

/** 验证 APK 使用的依赖能创建客户端，并可选验证本地握手。 */
public class WebSocketSmoke {
    public static void main(String[] args) throws Exception {
        final CountDownLatch echo = new CountDownLatch(1);
        WebSocketClient client = new WebSocketClient(new URI(
                args.length == 0 ? "ws://127.0.0.1:1" : args[0])) {
            public void onOpen(ServerHandshake handshake) { }
            public void onMessage(String message) {
                if ("smoke".equals(message)) echo.countDown();
            }
            public void onClose(int code, String reason, boolean remote) { }
            public void onError(Exception ex) { ex.printStackTrace(); }
        };
        if (args.length > 0) {
            if (!client.connectBlocking(10, TimeUnit.SECONDS)) {
                client.close();
                throw new AssertionError("WebSocket handshake failed");
            }
            client.send("smoke");
            if (!echo.await(5, TimeUnit.SECONDS)) {
                client.close();
                throw new AssertionError("WebSocket echo failed");
            }
            client.closeBlocking();
        }
        System.out.println("WebSocket smoke passed");
    }
}
