"""
End-to-end browser test of the built app (Chromium, iPhone-sized viewport)
against e2e/mock-supabase.mjs, which runs the real SQL schema in PGlite.

  npm run build:e2e && python3 e2e/run_e2e.py

Env: SHOTS_DIR=<dir> to save screenshots; EXPORT_DIR=<dir> to keep the xlsx.
"""
import json, os, subprocess, sys, time, urllib.request, datetime, tempfile
from zoneinfo import ZoneInfo
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get("E2E_BASE", "http://localhost:4173")
MOCK = "http://localhost:54321"
SHOTS = os.environ.get("SHOTS_DIR")
EXPORT_DIR = os.environ.get("EXPORT_DIR") or tempfile.mkdtemp()
TZ = ZoneInfo("Asia/Riyadh")
results = []


def admin(sql, params=None):
    req = urllib.request.Request(f"{MOCK}/__admin/sql", data=json.dumps({"sql": sql, "params": params or []}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req).read() or "[]")


def wait_http(url, timeout=40):
    t = time.time()
    while time.time() - t < timeout:
        try:
            urllib.request.urlopen(url)
            return
        except urllib.error.HTTPError:
            return
        except Exception:
            time.sleep(0.4)
    raise RuntimeError(f"{url} did not start")


def check(name, fn):
    try:
        fn()
        results.append((name, True, ""))
        print(f"  PASS  {name}")
    except Exception as e:  # noqa
        results.append((name, False, str(e).splitlines()[0][:300]))
        print(f"  FAIL  {name}: {str(e)[:500]}")


def shot(page, name):
    if SHOTS:
        page.wait_for_timeout(350)
        page.screenshot(path=os.path.join(SHOTS, f"{name}.png"))


def uid_of(email):
    return admin("select id::text from auth.users where email = $1", [email])[0]["id"]


def past_working_day():
    d = datetime.datetime.now(TZ).date() - datetime.timedelta(days=1)
    while d.weekday() in (4, 5):  # Fri, Sat (Python: Mon=0)
        d -= datetime.timedelta(days=1)
    return d


def open_calendar_day(page, d):
    page.get_by_role("link", name="Calendar", exact=True).click()
    today = datetime.datetime.now(TZ).date()
    for _ in range((today.year - d.year) * 12 + today.month - d.month):
        page.get_by_label("Previous month").click()
    page.get_by_label(f"{d.isoformat()} ", exact=False).first.click()


def main():
    mock = subprocess.Popen(["node", "e2e/mock-supabase.mjs"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    preview = subprocess.Popen(["npx", "vite", "preview", "--port", "4173", "--strictPort"], cwd=ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        wait_http(f"{MOCK}/rest/v1/")
        wait_http(BASE)
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx_opts = dict(viewport={"width": 393, "height": 852}, device_scale_factor=2, is_mobile=True, has_touch=True,
                            timezone_id="Asia/Riyadh", accept_downloads=True)
            ctx = browser.new_context(**ctx_opts)
            page = ctx.new_page()
            page.on("pageerror", lambda e: results.append(("no uncaught page errors", False, str(e)[:200])))

            # ---------------------------------------------------------- auth
            print("User A")
            page.goto(BASE + "/")
            check("unauthenticated user is sent to Log In", lambda: expect(page.get_by_role("button", name="Sign in")).to_be_visible())
            shot(page, "01-login")
            page.get_by_role("link", name="Create an account").click()
            page.get_by_label("Full name").fill("Anas Example")
            page.get_by_label("Email").fill("anas@example.com")
            page.get_by_label("Password", exact=True).fill("secret-pass-1")
            page.get_by_label("Confirm password").fill("secret-pass-1")
            page.get_by_role("button", name="Create account").click()
            check("sign up lands on the dashboard", lambda: expect(page.get_by_role("button", name="CLOCK IN")).to_be_visible(timeout=10000))
            check("greeting uses the registered name", lambda: expect(page.get_by_text("Anas", exact=False).first).to_be_visible())
            shot(page, "02-dashboard-before-clock-in")
            ua = uid_of("anas@example.com")

            # ------------------------------------------------------ clock in
            page.get_by_role("button", name="CLOCK IN").click()
            check("clock in shows the live timer and CLOCK OUT", lambda: (expect(page.get_by_text("Working")).to_be_visible(), expect(page.get_by_role("button", name="CLOCK OUT")).to_be_visible()))
            page.wait_for_timeout(1500)
            def one_active_session():
                rows = admin("select id::text, clock_in, clock_out from attendance_sessions where user_id = $1", [ua])
                assert len(rows) == 1 and rows[0]["clock_out"] is None, rows
            check("exactly one active session stored on the server", one_active_session)
            def reminder_7h40():
                r = admin("""select r.status, extract(epoch from (r.fire_at - s.clock_in))::int as secs
                             from reminders r join attendance_sessions s on s.id = r.session_id where s.user_id = $1""", [ua])
                assert r and r[0]["status"] == "scheduled" and r[0]["secs"] == 460 * 60, r
            check("reminder scheduled server-side at Clock In + 7h40", reminder_7h40)
            check("dashboard shows the reminder time", lambda: expect(page.get_by_text("Reminder at", exact=False)).to_be_visible())
            shot(page, "03-dashboard-working")

            page.reload()
            check("timer survives a reload (persisted timestamp)", lambda: expect(page.get_by_text("Working")).to_be_visible(timeout=10000))

            # ---------------------------------------------- clock out + undo
            page.get_by_role("button", name="CLOCK OUT").click()
            check("clock out shows completed attendance", lambda: expect(page.get_by_role("button", name="Undo Clock Out")).to_be_visible())
            check("under 8h is shown as Short (red)", lambda: expect(page.get_by_text("Short by", exact=False)).to_be_visible())
            check("reminder cancelled after early Clock Out", lambda: (lambda r: (_ for _ in ()).throw(AssertionError(r)) if r[0]["status"] != "cancelled" else None)(
                admin("select status from reminders where user_id = $1", [ua])))
            shot(page, "04-dashboard-clocked-out")
            page.get_by_role("button", name="Undo Clock Out").click()
            check("undo clock out resumes the same session", lambda: expect(page.get_by_role("button", name="CLOCK OUT")).to_be_visible())
            page.wait_for_timeout(800)
            def undo_ok():
                rows = admin("select clock_out from attendance_sessions where user_id = $1", [ua])
                assert len(rows) == 1 and rows[0]["clock_out"] is None, rows
                r = admin("select status from reminders where user_id = $1", [ua])
                assert r[0]["status"] == "scheduled", r
            check("undo keeps one session, removes Clock Out, reschedules reminder", undo_ok)
            page.get_by_role("button", name="CLOCK OUT").click()
            expect(page.get_by_role("button", name="Undo Clock Out")).to_be_visible()

            # ----------------------------------- remote work + conflict dialog
            d = past_working_day()
            open_calendar_day(page, d)
            shot(page, "05-day-editor-empty")
            page.get_by_role("button", name="Mark as Remote Work").click()
            page.wait_for_timeout(800)
            check("remote work saved for a past day", lambda: (lambda r: None if r else (_ for _ in ()).throw(AssertionError("no remote")))(
                admin("select 1 from remote_days where user_id = $1 and work_date = $2", [ua, d.isoformat()])))
            page.get_by_label(f"{d.isoformat()} ", exact=False).first.click()
            page.get_by_role("button", name="Convert to Office Attendance").click()
            page.get_by_label("Clock In").fill(f"{d.isoformat()}T08:00")
            page.get_by_label("Clock Out", exact=False).fill(f"{d.isoformat()}T16:30")
            check("form shows 8h 30m for 08:00–16:30 (not capped)", lambda: expect(page.get_by_text("Actual working time: 8h 30m")).to_be_visible())
            page.get_by_role("button", name="Save attendance").click()
            check("conflict dialog asks to replace Remote Work", lambda: expect(page.get_by_text("This day is already marked as Remote Work. Would you like to replace it with Office Attendance?")).to_be_visible())
            shot(page, "06-conflict-dialog")
            page.get_by_role("button", name="REPLACE").click()
            page.wait_for_timeout(1000)
            def replaced():
                assert not admin("select 1 from remote_days where user_id = $1 and work_date = $2", [ua, d.isoformat()])
                s = admin("select extract(epoch from clock_out - clock_in)::int as secs from attendance_sessions where user_id = $1 and work_date = $2", [ua, d.isoformat()])
                assert s and s[0]["secs"] == 510 * 60, s
            check("REPLACE swaps Remote Work for an 8h30 office record atomically", replaced)

            # --------------------------------------------------------- leave
            page.goto(f"{BASE}/leave")
            today = datetime.datetime.now(TZ).date()
            nxt_sun = today + datetime.timedelta(days=(6 - today.weekday()) % 7 or 7)
            page.get_by_role("button", name="Add").click()
            page.get_by_label("Start date").fill(nxt_sun.isoformat())
            page.get_by_label("End date").fill((nxt_sun + datetime.timedelta(days=6)).isoformat())
            check("annual leave over a full week counts 5 working days", lambda: expect(page.get_by_text("working days of leave", exact=False)).to_contain_text("5"))
            shot(page, "07-leave-form")
            page.get_by_role("button", name="Add leave").click()
            page.wait_for_timeout(800)
            page.get_by_role("button", name="Add").click()
            page.get_by_role("radio", name="Sick").click()
            page.get_by_label("Start date").fill((nxt_sun + datetime.timedelta(days=2)).isoformat())
            page.get_by_label("End date").fill((nxt_sun + datetime.timedelta(days=2)).isoformat())
            page.get_by_role("button", name="Add leave").click()
            check("overlapping leave triggers the conflict dialog", lambda: expect(page.get_by_text("Part of this period is already marked as Annual Leave", exact=False)).to_be_visible())
            page.get_by_role("button", name="CANCEL").click()
            page.wait_for_timeout(500)
            check("CANCEL keeps the original leave unchanged", lambda: (lambda r: None if len(r) == 1 else (_ for _ in ()).throw(AssertionError(r)))(
                admin("select leave_type from leaves where user_id = $1", [ua])))
            page.keyboard.press("Escape")
            shot(page, "08-leave-list")

            # ------------------------------------------------- reports + xlsx
            page.get_by_role("link", name="Reports", exact=True).click()
            check("monthly report renders the summary", lambda: expect(page.get_by_text("Scheduled working days")).to_be_visible())
            shot(page, "09-reports")
            with page.expect_download() as dl:
                page.get_by_role("button", name="Download Excel (.xlsx)").click()
            f = dl.value
            out = os.path.join(EXPORT_DIR, f.suggested_filename)
            f.save_as(out)
            month_name = datetime.datetime.now(TZ).strftime("%B_%Y")
            check("Excel download is a real .xlsx named Attendance_Report_<Month>_<Year>.xlsx",
                  lambda: (lambda b: None if f.suggested_filename == f"Attendance_Report_{month_name}.xlsx" and b[:2] == b"PK" else (_ for _ in ()).throw(AssertionError(f.suggested_filename)))(open(out, "rb").read()))
            page.get_by_role("link", name="Calendar", exact=True).click()
            shot(page, "10-calendar")
            page.get_by_role("link", name="History", exact=True).click()
            shot(page, "11-history")
            page.get_by_role("link", name="Settings", exact=True).click()
            shot(page, "12-settings")

            # ------------------------------------------------ user B: offline
            print("User B (offline sync, isolation, settings, deletion)")
            ctx2 = browser.new_context(**ctx_opts)
            pb = ctx2.new_page()
            pb.goto(f"{BASE}/signup")
            pb.get_by_label("Full name").fill("Second User")
            pb.get_by_label("Email").fill("second@example.com")
            pb.get_by_label("Password", exact=True).fill("secret-pass-2")
            pb.get_by_label("Confirm password").fill("secret-pass-2")
            pb.get_by_role("button", name="Create account").click()
            expect(pb.get_by_role("button", name="CLOCK IN")).to_be_visible(timeout=10000)
            ub = uid_of("second@example.com")
            pb.wait_for_timeout(1500)   # let the service worker install & precache
            check("user B sees none of user A's records", lambda: (pb.get_by_role("link", name="History", exact=True).click(), expect(pb.get_by_text("No records yet.")).to_be_visible()))
            pb.get_by_role("link", name="Today", exact=True).click()

            ctx2.set_offline(True)
            tap_time = datetime.datetime.now(datetime.timezone.utc)
            pb.get_by_role("button", name="CLOCK IN").click()
            check("offline Clock In is SAVED LOCALLY", lambda: expect(pb.get_by_text("Saved locally").first).to_be_visible())
            check("nothing reached the server while offline", lambda: (lambda r: None if not r else (_ for _ in ()).throw(AssertionError(r)))(
                admin("select 1 from attendance_sessions where user_id = $1", [ub])))
            shot(pb, "13-offline-saved-locally")
            pb.reload()
            check("app shell opens offline and the timer is still running", lambda: expect(pb.get_by_text("Working")).to_be_visible(timeout=10000))
            pb.wait_for_timeout(3000)
            ctx2.set_offline(False)
            pb.evaluate("window.dispatchEvent(new Event('online'))")
            check("back online → SYNCED", lambda: expect(pb.get_by_role("button", name="Sync status: Synced")).to_be_visible(timeout=15000))
            def synced_with_original_time():
                rows = admin("select clock_in from attendance_sessions where user_id = $1", [ub])
                assert len(rows) == 1, rows
                ci = datetime.datetime.fromisoformat(rows[0]["clock_in"].replace("Z", "+00:00"))
                assert abs((ci - tap_time).total_seconds()) < 5, (ci, tap_time)
            check("synced Clock In keeps the original tap time (not sync time), no duplicates", synced_with_original_time)

            pb.get_by_role("link", name="Settings", exact=True).click()
            pb.get_by_label("Reminder before completion").select_option("30")
            pb.get_by_role("button", name="Save", exact=True).click()
            pb.wait_for_timeout(1200)
            def lead30():
                r = admin("""select extract(epoch from (r.fire_at - s.clock_in))::int as secs from reminders r
                             join attendance_sessions s on s.id = r.session_id where s.user_id = $1""", [ub])
                assert r[0]["secs"] == 450 * 60, r
                a = admin("select lead_minutes from user_settings where user_id = $1", [ua])
                assert a[0]["lead_minutes"] == 20, a
            check("settings change reschedules the reminder for this user only", lambda: lead30())

            pb.goto(f"{BASE}/account")
            pb.get_by_role("button", name="Delete my account…").click()
            check("deletion offers data export first", lambda: expect(pb.get_by_role("button", name="Export my data first")).to_be_visible())
            shot(pb, "14-delete-account")
            pb.get_by_label("Type DELETE to confirm").fill("DELETE")
            pb.get_by_role("button", name="Permanently delete my account").click()
            check("after deletion the user is signed out", lambda: expect(pb.get_by_text("Your account and all of its data were deleted.")).to_be_visible(timeout=10000))
            def deleted():
                for t in ["attendance_sessions", "remote_days", "leaves", "reminders", "user_settings", "push_subscriptions"]:
                    assert not admin(f"select 1 from {t} where user_id = $1", [ub]), t
                assert not admin("select 1 from auth.users where id = $1", [ub])
                assert admin("select 1 from attendance_sessions where user_id = $1", [ua]), "user A data must remain"
            check("account deletion removes all of B's data and nothing of A's", deleted)

            # log in again (dark mode), then log out
            ctx3 = browser.new_context(**ctx_opts, color_scheme="dark")
            p3 = ctx3.new_page()
            p3.goto(f"{BASE}/login")
            p3.get_by_label("Email").fill("anas@example.com")
            p3.get_by_label("Password").fill("wrong-password")
            p3.get_by_role("button", name="Sign in").click()
            check("wrong password shows a clear error", lambda: expect(p3.get_by_text("Incorrect email or password.")).to_be_visible())
            p3.get_by_label("Password").fill("secret-pass-1")
            p3.get_by_role("button", name="Sign in").click()
            check("log in on another device shows the same data", lambda: expect(p3.get_by_role("button", name="Undo Clock Out")).to_be_visible(timeout=10000))
            shot(p3, "15-dashboard-dark")
            p3.get_by_role("link", name="Calendar", exact=True).click()
            shot(p3, "16-calendar-dark")
            p3.reload()
            check("login persists across app restarts", lambda: expect(p3.get_by_role("heading", name="Calendar")).to_be_visible(timeout=10000))
            p3.get_by_role("link", name="Settings", exact=True).click()
            p3.get_by_role("button", name="Sign out", exact=True).click()
            p3.get_by_role("button", name="SIGN OUT", exact=True).click()
            check("log out returns to the sign-in screen", lambda: expect(p3.get_by_role("button", name="Sign in")).to_be_visible(timeout=10000))

            # ---------------------------------------- links from auth e-mails
            # Supabase redirects e-mail links to the app with the session in the
            # URL fragment. Simulate exactly those redirects.
            print("E-mail links")
            def mock_session(email, password):
                req = urllib.request.Request(f"{MOCK}/auth/v1/token?grant_type=password",
                                             data=json.dumps({"email": email, "password": password}).encode(),
                                             headers={"Content-Type": "application/json"}, method="POST")
                return json.loads(urllib.request.urlopen(req).read())
            s = mock_session("anas@example.com", "secret-pass-1")
            frag = f"access_token={s['access_token']}&expires_at={s['expires_at']}&expires_in=3600&refresh_token={s['refresh_token']}&token_type=bearer"
            ctx4 = browser.new_context(**ctx_opts)
            p4 = ctx4.new_page()
            p4.goto(f"{BASE}/#{frag}&type=signup")
            check("'Confirm email' link signs the new user in", lambda: expect(p4.get_by_role("button", name="Undo Clock Out")).to_be_visible(timeout=10000))
            check("tokens are removed from the address bar", lambda: (lambda u: None if "access_token" not in u else (_ for _ in ()).throw(AssertionError(u)))(p4.url))
            ctx5 = browser.new_context(**ctx_opts)
            p5 = ctx5.new_page()
            p5.goto(f"{BASE}/reset-password#{frag}&type=recovery")
            check("'Reset password' link opens the new-password screen", lambda: expect(p5.get_by_role("heading", name="Choose a new password")).to_be_visible(timeout=10000))
            shot(p5, "17-reset-password")
            p5.get_by_label("New password", exact=True).fill("brand-new-pass-9")
            p5.get_by_label("Confirm new password").fill("brand-new-pass-9")
            p5.get_by_role("button", name="Save password").click()
            check("after saving, the user lands in the app", lambda: expect(p5.get_by_role("button", name="Undo Clock Out")).to_be_visible(timeout=10000))
            check("the new password works for sign-in", lambda: mock_session("anas@example.com", "brand-new-pass-9")["access_token"])
            p6 = browser.new_context(**ctx_opts).new_page()
            p6.goto(f"{BASE}/reset-password")
            check("an expired/invalid reset link shows a clear message", lambda: expect(p6.get_by_text("Link expired")).to_be_visible(timeout=10000))

            # ------------------------------------------------ Google sign-in
            print("Google sign-in")
            ctx7 = browser.new_context(**ctx_opts)
            p7 = ctx7.new_page()
            p7.goto(f"{BASE}/signup")
            check("sign-up screen offers Continue with Google", lambda: expect(p7.get_by_role("button", name="Continue with Google")).to_be_visible())
            shot(p7, "18-signup-google")
            p7.get_by_role("button", name="Continue with Google").click()
            check("Google sign-in creates the account and opens the app", lambda: expect(p7.get_by_role("button", name="CLOCK IN")).to_be_visible(timeout=15000))
            check("profile name comes from Google", lambda: expect(p7.get_by_text("Google", exact=False).first).to_be_visible())
            def g_profile():
                r = admin("select p.full_name from public.profiles p join auth.users u on u.id = p.id where u.email = 'friend.google@example.com'")
                assert r and r[0]["full_name"] == "Google Friend", r
            check("Google account gets its own profile and default settings", g_profile)
            p7.get_by_role("link", name="History", exact=True).click()
            check("Google user sees none of the existing user's records", lambda: expect(p7.get_by_text("No records yet.")).to_be_visible())
            p7.goto(f"{BASE}/account")
            check("Google account shows its sign-in method instead of a password form", lambda: (expect(p7.get_by_text("You sign in with Google")).to_be_visible(), expect(p7.get_by_role("heading", name="Change password")).to_have_count(0)))
            p7.get_by_role("link", name="Settings", exact=True).click() if p7.get_by_role("link", name="Settings", exact=True).count() else None
            p7.goto(f"{BASE}/settings")
            p7.get_by_role("button", name="Sign out", exact=True).click()
            p7.get_by_role("button", name="SIGN OUT", exact=True).click()
            expect(p7.get_by_role("button", name="Continue with Google")).to_be_visible(timeout=10000)
            p7.get_by_role("button", name="Continue with Google").click()
            check("signing in with Google again opens the same account", lambda: expect(p7.get_by_role("button", name="CLOCK IN")).to_be_visible(timeout=15000))
            check("no duplicate account is created", lambda: (lambda r: None if r[0]["n"] == 1 else (_ for _ in ()).throw(AssertionError(r)))(
                admin("select count(*)::int as n from auth.users where email = 'friend.google@example.com'")))
            browser.close()
    finally:
        mock.terminate()
        preview.terminate()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    with open(os.path.join(ROOT, "e2e", "last-results.json"), "w") as fh:
        json.dump([{"test": n, "passed": ok, "error": err} for n, ok, err in results], fh, indent=2)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
