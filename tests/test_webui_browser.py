"""Playwright (Edge UA) against the real Flask dashboard: type a name in the unknown-faces queue while it auto-refreshes, save with Enter."""
import os, shutil, sys, tempfile, threading, time
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp()); shutil.copy(ROOT / "config.yaml", tmp / "config.yaml")
os.environ["PMC_BASE"] = str(tmp); sys.path.insert(0, str(ROOT))
import cv2, numpy as np
from werkzeug.serving import make_server
from webui import server as S
from playwright.sync_api import sync_playwright
jpg = cv2.imencode(".jpg", np.full((60, 60, 3), 120, np.uint8))[1].tobytes()
(tmp / "unknown_faces").mkdir()
for i in range(3): (tmp / f"unknown_faces/unknown_{i}.jpg").write_bytes(jpg)
srv = make_server("127.0.0.1", 0, S.app, threaded=True); port = srv.server_port
threading.Thread(target=srv.serve_forever, daemon=True).start()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(user_agent=UA).new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"http://127.0.0.1:{port}/"); pg.click("text=Attendance")
    pg.wait_for_selector("#unkList .unk input")
    inp = pg.locator("#unkList .unk input").first; inp.click(); pg.keyboard.type("Pri")
    (tmp / "unknown_faces/unknown_9.jpg").write_bytes(jpg)          # new unknown arrives mid-typing
    pg.evaluate("loadUnknown()"); pg.wait_for_function("document.querySelectorAll('#unkList .unk').length === 4")
    pg.keyboard.type("ya"); assert pg.evaluate("document.activeElement.value") == "Priya"
    pg.keyboard.press("Enter"); pg.wait_for_function("document.querySelectorAll('#unkList .unk').length === 3")
    assert list((tmp / "known_faces/Priya").glob("*.jpg")), "not moved"
    i2 = pg.locator("#unkList .unk input").first; i2.fill("Arjun"); pg.locator("#unkList .unk button.primary").first.click()
    pg.wait_for_function("document.querySelectorAll('#unkList .unk').length === 2"); assert (tmp / "known_faces/Arjun").exists()
    pg.wait_for_selector("text=Arjun · 1 photo(s)")
    for t in ["Live", "Modules", "Zones", "Events", "Plates", "Settings", "System"]: pg.click(f"#tabs >> text={t}"); time.sleep(0.4)
    pg.click("#tabs >> text=Modules"); pg.wait_for_selector("#modList details"); pg.screenshot(path=str(tmp / "mods.png"))
    b.close()
assert not errs, errs
print("dashboard browser test PASS")
