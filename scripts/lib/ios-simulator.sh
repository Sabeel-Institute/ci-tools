# shellcheck shell=bash
# Sourced by native-build and native-e2e, which must agree on the simulator:
# the one built for is the one booted.

# ios_simulator: the UDID of a booted iPhone simulator, else of the newest one
# available. With IOS_SIMULATOR set to a model's name ("iPhone 17 Pro Max"),
# only that model, on the newest runtime that has it: store screenshots are
# taken at the sizes of particular phones.
ios_simulator() {
  xcrun simctl list devices available -j | node -e '
    const { devices } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const named = process.env.IOS_SIMULATOR || "";
    const phones = Object.entries(devices)
      .filter(([runtime]) => /SimRuntime\.iOS-/.test(runtime))
      .flatMap(([runtime, list]) => list.map((device) => ({ ...device, runtime })))
      .filter((device) => /^iPhone/.test(device.name));
    const newest = (a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true });
    const candidates = named ? phones.filter((device) => device.name === named) : phones;
    const pick = candidates.find((device) => device.state === "Booted") ?? candidates.sort(newest)[0];
    if (!pick) {
      const names = [...new Set(phones.map((device) => device.name))].join(", ");
      console.error(named ? "no \"" + named + "\" simulator is available; there are: " + names : "no iPhone simulator is available");
      process.exit(1);
    }
    console.log(pick.udid);'
}
