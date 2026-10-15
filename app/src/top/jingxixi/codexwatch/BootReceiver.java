package top.jingxixi.codexwatch;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 开机自启网关服务(BOOT_COMPLETED 受系统 RECEIVE_BOOT_COMPLETED 保护) */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
                GatewayService.start(context);
            }
        } catch (Throwable ignored) {
            // Android 12+/14+ 对开机拉起前台服务有 BAL / dataSync 限制,
            // 任何系统版本拒启都不能让 receiver 崩溃:完全包死。
        }
    }
}
