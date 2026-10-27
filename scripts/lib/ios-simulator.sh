# shellcheck shell=bash
# Sourced by native-build and native-e2e, which must agree on the simulator:
# the one built for is the one booted.

# ios_simulator: the UDID of a booted iPhone simulator, else of the newest one available.
ios_simulator() {
  xcrun simctl list devices available -j | node -e '
    const { devices } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const phones = Object.entries(devices)
      .filter(([runtime]) => /SimRuntime\.iOS-/.test(runtime))
      .flatMap(([runtime, list]) => list.map((device) => ({ ...device, runtime })))
      .filter((device) => /^iPhone/.test(device.name));
    const newest = (a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true });
    const pick = phones.find((device) => device.state === "Booted") ?? phones.sort(newest)[0];
    if (!pick) { console.error("no iPhone simulator is available"); process.exit(1); }
    console.log(pick.udid);'
}
