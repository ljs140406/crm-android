package cn.ljs140406.crm;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 允许 WebView 铺到系统栏下方，配合 CSS env(safe-area-inset-*) 做沉浸式适配
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    }
}
