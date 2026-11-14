package io.github.maxwooow.grmod.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import java.util.List;

import org.json.JSONObject;
import org.junit.Test;

public class RicohTest {
    @Test public void parsesRowsAndLinks() {
        String page = "<table><tr><td>GR IV / GR IV HDF</td><td><a href=\"digital/gr4_s.html\">x</a></td><td>1.20</td></tr>"
                + "<!-- <tr><td>GR IV</td><td>9.99</td></tr> --><tr><th>Applied product</th><td>RICOH GR IV&nbsp;/ RICOH GR IV HDF</td></tr></table>"
                + "<a href='/resources/x/gr4_v120.zip?x=1'>dl</a>";
        List<Ricoh.Row> rows = Ricoh.rows(page);
        assertEquals(2, rows.size());
        String[] e = Ricoh.indexEntry(rows, "GR IV HDF");
        assertNotNull(e);
        assertEquals("digital/gr4_s.html", e[0]);
        assertEquals("1.20", e[1]);
        assertTrue(Ricoh.appliesTo(Ricoh.field(rows, "Applied product"), "GR IV HDF"));
        assertEquals("/resources/x/gr4_v120.zip?x=1", Ricoh.archiveLink(page));
        assertEquals(33671L * 1024, Ricoh.statedSize("Gr4_v111.zip (zip type file 33,671KB)"));
        assertEquals("a & b", Ricoh.unescape("a &amp; b"));
    }

    /** Against the live site, when it can be reached (Nov 2026: GR IV 1.21, Monochrome 1.11, GR III 2.21, GR IIIx 1.71). */
    @Test public void liveReleases() throws Exception {
        Ricoh r = new Ricoh(null);
        String[][] cases = {{"HDF", "1.20"}, {"STANDARD", "1.20"}, {"MONO", "1.10"}, {"GR3", "2.20"}, {"GR3X_HDF", "1.70"}};
        for (String[] c : cases) {
            JSONObject o;
            try { o = r.latestJson(c[0]); }
            catch (java.io.IOException e) { assumeTrue("site not reachable: " + e, false); return; }
            System.out.println(c[0] + " " + o);
            String v = o.getString("version");
            JSONObject fb = o.optJSONObject("fallback");
            assertTrue(c[0] + ": " + o, v.equals(c[1]) || (fb != null && fb.getString("version").equals(c[1])));
            Ricoh.Release ch = r.chosen(c[0], c[1]);
            assertEquals(c[1], ch.version);
            assertTrue(ch.size > 20_000_000);
        }
    }
}
