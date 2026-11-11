package io.github.maxwooow.grmod;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import io.github.maxwooow.grmod.push.GrCameraPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GrCameraPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
