"""Playwright: web app v8 'Test with file' — sample image (people, repeat frames) and short video through the live pipeline."""
import functools, http.server, json, socketserver, sys, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DOCS, SAMPLES = ROOT / "docs", ROOT / "tests/samples"
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DOCS)); h.log_message = lambda *a: None
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), h); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
seed = {"mod_occupancy": {"enabled": True, "max": 1, "holdSec": 1, "telegram": False},
        "mod_zone": {"enabled": True, "zones": [{"name": "all", "points": [[0, 0], [1, 0], [1, 1], [0, 1]]}], "telegram": False, "cooldown": 0},
        "mod_counter": {"enabled": True}, "mod_motion": {"enabled": True}}
init = "if(!sessionStorage.s){" + "".join(f"localStorage.setItem({json.dumps(k)},{json.dumps(json.dumps(v))});" for k, v in seed.items()) + "sessionStorage.s=1}"
ok = True
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.add_init_script(init); pg.goto(f"http://127.0.0.1:{port}/index.html")
    print("version:", pg.text_content("#ver"))
    # image
    pg.set_input_files("#testFile", str(SAMPLES / "people.jpg"))
    pg.wait_for_selector("#fileResults h4", timeout=180000)
    print("IMAGE:", pg.inner_text("#fileResults")[:400].replace("\n", " | "))
    ev = pg.evaluate("JSON.parse(localStorage.sc_events).filter(e=>e.src==='file:people.jpg').map(e=>e.module+':'+e.type)")
    print("image events:", ev); ok &= any(e.startswith("occupancy") for e in ev) and any(e.startswith("zone") for e in ev)
    ok &= "person" in pg.inner_text("#fileResults")
    pg.screenshot(path="/tmp/web_image.png")
    # video
    pg.set_input_files("#testFile", str(SAMPLES / "people.webm"))
    pg.wait_for_function("document.getElementById('video').currentTime > 0.5", timeout=120000)
    pg.click("#vidPlay"); paused = pg.evaluate("document.getElementById('video').paused"); pg.click("#vidPlay")
    pg.select_option("#vidSpeed", "2")
    pg.wait_for_selector("#fileResults h4", timeout=120000)
    print("VIDEO:", pg.inner_text("#fileResults")[:300].replace("\n", " | "), "| paused-toggle:", paused)
    vev = pg.evaluate("JSON.parse(localStorage.sc_events).filter(e=>e.src==='file:people.webm').length"); print("video events:", vev)
    ok &= vev > 0 and paused
    pg.screenshot(path="/tmp/web_video.png")
    pg.click("#fileBack"); ok &= pg.is_hidden("#filePanel")
    b.close()
print("errors:", errs); ok &= not errs
print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
