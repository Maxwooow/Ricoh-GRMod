package io.github.maxwooow.grmod.push;

import static org.junit.Assert.assertEquals;

import org.junit.After;
import org.junit.Test;

public class LTest {
    @After
    public void reset() { L.set("zh"); }

    @Test
    public void picksTheLanguage() {
        String zh = "相机电量为 {0}%，请充电至 {1}% 以上后再推送。";
        String en = "The camera's battery is at {0}%: charge it above {1}% first";
        L.set("zh");
        assertEquals("相机电量为 20%，请充电至 30% 以上后再推送。", L.f(zh, en, 20, 30));
        L.set("en");
        assertEquals("The camera's battery is at 20%: charge it above 30% first", L.f(zh, en, 20, 30));
        L.set("de");
        assertEquals("Der Akku der Kamera steht bei 20 %: zuerst über 30 % laden.", L.f(zh, en, 20, 30));
        L.set("ja-JP");
        assertEquals("ja", L.lang);
    }

    @Test
    public void traditionalChinese() {
        assertEquals("zh-TW", L.norm("zh-Hant-HK"));
        assertEquals("zh-TW", L.norm("zh_TW"));
        assertEquals("zh", L.norm("zh-CN"));
        assertEquals("en", L.norm("fr"));
        L.set("zh-TW");
        assertEquals("已取消", L.s("已取消", "Cancelled"));
        assertEquals("沒翻譯", L.s("沒翻譯", "not in the table"));
        L.set("ko");
        assertEquals("not in the table", L.s("沒翻譯", "not in the table"));
    }
}
