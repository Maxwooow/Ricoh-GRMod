package io.github.maxwooow.grmod.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import java.io.File;
import java.io.FileOutputStream;

import org.junit.Test;

public class FirmwareInfoTest {
    /** The official GR IV 1.20 file, kept out of the repository (core/testdata/private). */
    static File official() {
        return new File("../../../core/testdata/private/official120.bin");
    }

    @Test public void readsTheOfficialFile() throws Exception {
        File f = official();
        assumeTrue("official120.bin not present", f.isFile());
        L.set("zh");
        FirmwareInfo i = FirmwareInfo.read(f);
        assertTrue(i.describe(), i.container);
        assertEquals("7563d7e462f0c53b6ab2fbab7cdfbbb57151a41192ee82f4f3a2108f9d77650d", i.sha256);
        assertEquals("GR IV 官方 1.20", i.official);
        L.set("en");
        assertEquals("GR IV official 1.20", FirmwareInfo.read(f).official);
        L.set("zh");
        assertEquals("GR IV", i.fileName);
        assertEquals("1.20.10.11", i.version);
        assertEquals(3, i.models.size());
        assertEquals("1.20.10.11", i.modelFor("RICOH GR IV").version);
        assertEquals("1.20.10.11", i.modelFor("RICOH GR IV HDF").version);
        assertEquals("1.10.10.4", i.modelFor("RICOH GR IV Monochrome").version);
        assertEquals("1.10", i.modelFor("RICOH GR IV Monochrome").base());
        assertNull(i.modelFor("RICOH GR III"));
    }

    @Test public void refusesOtherFiles() throws Exception {
        File f = File.createTempFile("not-fw", ".bin");
        try (FileOutputStream o = new FileOutputStream(f)) { o.write(new byte[4096]); }
        FirmwareInfo i = FirmwareInfo.read(f);
        assertFalse(i.container);
        assertNotNull(i.error);
        f.delete();
    }
}
