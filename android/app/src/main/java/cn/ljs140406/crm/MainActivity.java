package cn.ljs140406.crm;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 自定义插件必须在 super.onCreate() 之前注册，否则 Bridge 建好后再注册无效，
        // JS 侧 Capacitor.Plugins.ApkUpdater 会是 undefined。
        registerPlugin(ApkUpdater.class);
        super.onCreate(savedInstanceState);
        // 允许 WebView 铺到系统栏下方，配合 CSS env(safe-area-inset-*) 做沉浸式适配
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    }
}
