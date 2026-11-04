"""Playwright: type a name into the unknown-face queue (Edge UA), with a re-render mid-typing, then save via Enter and via button."""
import json, sys, threading, functools, http.server, socketserver
from pathlib import Path
from playwright.sync_api import sync_playwright

DOCS = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "docs")
EDGE_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
           "Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")
PX = "data:image/gif;base64,R0lGODlhAQABAAAAACw="
unk = [{"id": f"U{i}", "desc": [0.0] * 128, "thumb": PX, "firstSeen": 1, "lastSeen": 1, "count": 1} for i in range(3)]

h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DOCS))
h.log_message = lambda *a: None
srv = socketserver.TCPServer(("127.0.0.1", 0), h); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
ok = True
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(user_agent=EDGE_UA).new_page()
    pg.add_init_script(f"if(!sessionStorage.seeded){{localStorage.setItem('unknowns', {json.dumps(json.dumps(unk))});localStorage.setItem('attendance','[{{\"name\":\"Unknown U0\",\"in\":1,\"out\":1}}]');sessionStorage.seeded=1}}")
    pg.goto(f"http://127.0.0.1:{port}/index.html")
    print("version:", pg.text_content("#ver"))
    pg.evaluate("document.getElementById('mod_attendance').open = true")
    inp = pg.locator('.unk[data-id="U0"] input') if pg.locator('.unk[data-id]').count() else pg.locator('#unkList .unk').last.locator('input')
    inp.click(); pg.keyboard.type("Ali")
    # queue changes while typing (another unknown discarded -> renderUnk), like new unknowns arriving live
    pg.evaluate("[...document.querySelectorAll('#unkList .unk')][0].querySelector('button:not(.primary)').click()")
    pg.keyboard.type("ce")
    val = pg.evaluate("document.activeElement && document.activeElement.value")
    print("focused value after re-render:", repr(val)); ok &= val == "Alice"
    pg.keyboard.press("Enter")
    faces = pg.evaluate("JSON.parse(localStorage.faces||'[]').map(f=>f.name)")
    att = pg.evaluate("JSON.parse(localStorage.attendance||'[]').map(a=>a.name)")
    print("faces:", faces, "attendance:", att); ok &= "Alice" in faces and "Alice" in att
    # second one via Save button
    i2 = pg.locator('#unkList .unk input').first; i2.click(); pg.keyboard.type("Bob Kumar")
    pg.locator('#unkList .unk button.primary').first.click()
    faces = pg.evaluate("JSON.parse(localStorage.faces||'[]').map(f=>f.name)")
    print("faces:", faces, "left in queue:", pg.locator('#unkList .unk').count()); ok &= "Bob Kumar" in faces
    b.close()
print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
