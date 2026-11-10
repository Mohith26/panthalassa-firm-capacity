"""Download NOAA NDBC standard meteorological history for three deep-water North Pacific
buoys and write hourly significant wave height (WVHT) and average period (APD) to
data/buoys.json. Public data: https://www.ndbc.noaa.gov/ (no login).

Usage: python3 scripts/fetch_ndbc.py   (stdlib only; downloads ~6 MB into data/raw/)
"""
import gzip, json, os, urllib.request, datetime as dt

BUOYS = {
    "46005": "West Washington, 315 nm offshore",
    "46006": "Southeast Papa, 600 nm west of Eureka",
    "46059": "West California, 357 nm west of San Francisco",
}
YEARS = [2023, 2024]
START = dt.datetime(2023, 1, 1)
END = dt.datetime(2025, 1, 1)
ROOT = os.path.join(os.path.dirname(__file__), "..", "data")
RAW = os.path.join(ROOT, "raw")


def fetch(b, y):
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, f"{b}h{y}.txt.gz")
    if not os.path.exists(path):
        url = f"https://www.ndbc.noaa.gov/data/historical/stdmet/{b}h{y}.txt.gz"
        try:
            urllib.request.urlretrieve(url, path)
        except Exception as e:  # some buoy-years are not published
            print("skip", b, y, e)
            return None
    return path


def parse(path):
    lines = gzip.open(path, "rt").read().splitlines()
    hdr = lines[0].lstrip("#").split()
    iw, ia = hdr.index("WVHT"), hdr.index("APD")
    out = {}
    for ln in lines[2:]:
        p = ln.split()
        if len(p) < len(hdr):
            continue
        hs, apd = float(p[iw]), float(p[ia])
        if hs >= 99 or apd >= 99 or hs <= 0 or apd <= 0:
            continue
        t = dt.datetime(int(p[0]), int(p[1]), int(p[2]), int(p[3]))
        out.setdefault(t, (hs, apd))  # first report in the hour
    return out


def main():
    n = int((END - START).total_seconds() // 3600)
    series = {}
    for b in BUOYS:
        rec = {}
        for y in YEARS:
            p = fetch(b, y)
            if p:
                rec.update(parse(p))
        hs, apd = [None] * n, [None] * n
        for t, (h, a) in rec.items():
            i = int((t - START).total_seconds() // 3600)
            if 0 <= i < n:
                hs[i], apd[i] = round(h, 2), round(a, 2)
        # fill gaps of up to 6 hours by linear interpolation; longer gaps stay null
        for arr in (hs, apd):
            i = 0
            while i < n:
                if arr[i] is None:
                    j = i
                    while j < n and arr[j] is None:
                        j += 1
                    if 0 < i and j < n and j - i <= 6:
                        a, b2 = arr[i - 1], arr[j]
                        for k in range(i, j):
                            arr[k] = round(a + (b2 - a) * (k - i + 1) / (j - i + 1), 2)
                    i = j
                else:
                    i += 1
        series[b] = {"name": BUOYS[b], "hs": hs, "apd": apd,
                     "valid": sum(x is not None for x in hs)}
        print(b, "valid hours", series[b]["valid"], "of", n)
    out = {"source": "NOAA National Data Buoy Center, standard meteorological history",
           "start": START.isoformat() + "Z", "hours": n, "buoys": series}
    with open(os.path.join(ROOT, "buoys.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
