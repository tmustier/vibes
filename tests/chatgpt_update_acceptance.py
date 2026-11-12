#!/usr/bin/env python3
"""Mac acceptance with a signed old ChatGPT archive and a separate background app.

Usage: python3 tests/chatgpt_update_acceptance.py OLD_CHATGPT.zip --artifacts DIRECTORY
Does not change /Applications/ChatGPT.app, the user's state or installed launch agents.
"""
import argparse
import datetime as dt
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shlex
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader("chatgpt_update", str(ROOT / "scripts/chatgpt-update"))
spec = importlib.util.spec_from_loader(loader.name, loader)
u = importlib.util.module_from_spec(spec)
loader.exec_module(u)

SENTINEL = r'''
#import <Cocoa/Cocoa.h>
#include <unistd.h>
static void record(NSString *event) {
    NSString *path = [[[NSBundle mainBundle] bundlePath] stringByAppendingPathComponent:@"Contents/events.log"];
    NSString *line = [NSString stringWithFormat:@"%d %@\n",getpid(),event];
    NSFileHandle *file = [NSFileHandle fileHandleForWritingAtPath:path];
    if (!file) [line writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    else { [file seekToEndOfFile]; [file writeData:[line dataUsingEncoding:NSUTF8StringEncoding]]; [file closeFile]; }
}
@interface Delegate : NSObject <NSApplicationDelegate>
@end
@implementation Delegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification { record(@"launched"); }
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender { record(@"quit"); return NSTerminateNow; }
@end
int main(void) { @autoreleasepool {
 NSApplication *app=[NSApplication sharedApplication]; Delegate *delegate=[Delegate new];
 app.delegate=delegate; [app setActivationPolicy:NSApplicationActivationPolicyProhibited]; [app run];
} }
'''


def live_pids():
    return subprocess.run(["pgrep", "-x", "ChatGPT"], capture_output=True, text=True).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--artifacts", required=True, type=Path)
    args = parser.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    before_live = live_pids()
    app_id = "ai.vibes.vibes-updater-acceptance." + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="vibes-chatgpt-acceptance-", ignore_cleanup_errors=True) as directory:
        scratch = Path(directory)
        target = scratch/"ChatGPT.app"
        sentinel = scratch/"Sentinel.app"
        (sentinel/"Contents/MacOS").mkdir(parents=True)
        info = dict(CFBundleExecutable="sentinel", CFBundleIdentifier=app_id,
                    CFBundleName="Vibes updater acceptance", CFBundlePackageType="APPL",
                    CFBundleVersion="1", CFBundleShortVersionString="1.0", LSUIElement=True)
        with (sentinel/"Contents/Info.plist").open("wb") as out:
            plistlib.dump(info, out)
        source = scratch/"sentinel.m"
        source.write_text(SENTINEL)
        subprocess.run(["xcrun", "clang", "-fobjc-arc", "-framework", "Cocoa", str(source), "-o", str(sentinel/"Contents/MacOS/sentinel")], check=True)
        subprocess.run(["codesign", "--force", "--sign", "-", str(sentinel)], check=True)
        subprocess.run(["ditto", "-x", "-k", str(args.archive.resolve()), str(scratch)], check=True)
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(target)], check=True)
        state_dir = scratch/"state"
        state_file = state_dir/"vibes-chatgpt-update.json"
        now = dt.datetime.now(dt.timezone.utc)
        u.save_state(state_file, {"completedSlot": u.weekly_slot(now)})
        native = u.NativeUpdater(target, state_dir/"chatgpt-updater", sentinel)
        old_version = native.version()
        events = sentinel/"Contents/events.log"
        try:
            subprocess.run(["open", "-g", "-j", str(sentinel)], check=True)
            end = time.monotonic()+30
            while not events.exists():
                if time.monotonic()>end:
                    raise RuntimeError("Acceptance app did not start")
                time.sleep(.2)
            # Use the real Vibes wrapper. Deferred installers must survive its group cleanup.
            shell = ('source scripts/vibes; LOCK_FILE='+shlex.quote(str(state_dir/"vibes-update.flock"))+
                     '; export VIBES_UPDATE_LOCKED=1; with_lock python3 scripts/chatgpt-update --app '+shlex.quote(str(target))+
                     ' --application '+shlex.quote(str(sentinel))+' --state-dir '+shlex.quote(str(state_dir)))
            with (args.artifacts/"stage.log").open("w") as log:
                subprocess.run(["bash", "-c", shell], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=300)
            assert u.read_state(state_file)["status"] == "staged"
            assert native.version() == old_version
            assert events.read_text().count("launched") == 1
            assert native.running()
            notices = []
            deadline = dt.datetime.fromtimestamp(u.next_weekly_slot(now), dt.timezone.utc)
            # Simulate continuous wake for the scheduled times; real native commands still run.
            def tick(moment):
                return u.run(state_file, native, moment, "acceptance", notices.append,
                             monotonic=lambda: moment.timestamp())
            assert tick(deadline-dt.timedelta(minutes=10)) == 0
            assert len(notices) == 1 and "10 minutes" in notices[0]
            assert native.version() == old_version
            assert tick(deadline-dt.timedelta(minutes=5)) == 0
            assert tick(deadline) == 0
            state = u.read_state(state_file)
            assert state["status"] == "updated", state
            assert state["completedSlot"] == deadline.timestamp()
            assert native.version() != old_version
            event_text = events.read_text()
            assert event_text.count("launched") == 2 and "quit" in event_text, event_text
            assert native.running()
            assert live_pids() == before_live, "The user's live ChatGPT process changed"
            result = {"oldBuild": old_version, "newBuild": native.version(), "warningCount": len(notices),
                      "deferredInstallerSurvivedWrapper": True, "nativeRelaunchVerified": True,
                      "liveChatGPTUnchanged": True, "state": state, "events": event_text,
                      "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()}
            (args.artifacts/"result.json").write_text(json.dumps(result, indent=2))
            print(json.dumps(result, indent=2))
        finally:
            subprocess.run(["osascript", "-e", f'tell application id "{app_id}" to quit'], capture_output=True, timeout=20)


if __name__ == "__main__":
    main()
