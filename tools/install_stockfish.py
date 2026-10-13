"""Install the native Stockfish 19 that test/stockfish_check.py and test/engine_gauntlet.py referee with.

    python tools/install_stockfish.py            # download, verify, unpack; prints the binary's path
    python tools/install_stockfish.py --path     # just print the path of an installed one (exit 1 if none)
    python tools/install_stockfish.py --syzygy   # the folder of the installed tablebases (exit 1 if none)

It goes in .tools/stockfish-19/ beside this repo (git ignores .tools/), and both checks find it
there on their own, so after this `python test/stockfish_check.py` needs no argument.

The build is the official release's "universal" one for this OS and processor: a single binary
that picks the fastest code its CPU supports. The archive is checked against the SHA-256 the
release publishes before anything is unpacked, and the binary has to answer the UCI handshake
as "Stockfish 19" before it counts as installed. Running it again does nothing once that holds.

It also installs the 3- and 4-piece Syzygy tablebases (4.3 MB, .tools/syzygy-34/), which the check
hands Stockfish. Without them Stockfish scores a fortress by its material: the wrong-bishop study,
a draw the tablebase proves, came out as a pawn up for White. Each file is checked against a pinned
SHA-256 before it is kept.
"""
import hashlib, io, os, platform, shutil, ssl, stat, subprocess, sys, tarfile, urllib.request, zipfile

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
HOME = os.path.join(ROOT, ".tools", "stockfish-19")
RELEASE = "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/"
VERSION = "Stockfish 19"
SYZYGY_HOME = os.path.join(ROOT, ".tools", "syzygy-34")
SYZYGY_URL = "https://tablebase.lichess.ovh/tables/standard/3-4-5-%s/"   # wdl / dtz

# (system, machine) -> (asset, its SHA-256 as published with the sf_19 release, 2026-09-05)
ASSETS = {
    ("windows", "x86_64"): ("stockfish-windows-x86-64-universal.zip",
                            "3c8bf1f9ea66a09350a40df4f632288285ac206d99f33ab5842c408fc30b48a7"),
    ("windows", "arm64"): ("stockfish-windows-arm64-universal.zip",
                           "8372ad3f0d7276deb2c70f801f541ec7db463219fc6d9c7592864e542aa4f401"),
    ("linux", "x86_64"): ("stockfish-linux-x86-64-universal.tar.gz",
                          "9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f"),
    ("linux", "arm64"): ("stockfish-linux-arm64-universal.tar.gz",
                         "fe26cfd1d9db4c8af3d21e24d9ff34cacb31c1f940085a7583da11796f2bac01"),
    ("linux", "riscv64"): ("stockfish-linux-riscv64-universal.tar.gz",
                           "d4b4d118c003bc669a939d9fb208e3ef6b367730fd79a70dbc278b18475df3d1"),
    ("darwin", "x86_64"): ("stockfish-macos-universal.tar.gz",
                           "a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77"),
    ("darwin", "arm64"): ("stockfish-macos-universal.tar.gz",
                          "a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77"),
}
# The 3- and 4-piece Syzygy tables (WDL and DTZ), and the SHA-256 of each. Pinned 2026-10-13, when
# tablebase.lichess.ovh and tablebase.sesse.net served byte-identical copies of all 70.
SYZYGY = {
    "KBBvK.rtbw": "3afa74fcfd6100df851c3b18ca255acd9d68c31c7c74cb02b2d5236ffd610ed6",
    "KBBvK.rtbz": "d3786ba13d73b1ed61b8be4fd301ceed56b9af5e7c4fbf4a252ef77d2ea3d3db",
    "KBNvK.rtbw": "76958da65bc243f2f0a16ceb83f1c00cbc4fb6d6e2f43d052c2f9d65bf16fee8",
    "KBNvK.rtbz": "cad874516a2327e63754b3faababc7dece1b949305f2944b2b5a3b137f92ecd3",
    "KBPvK.rtbw": "4714e6844d18eea21b9e7be3c8b2f5b04739638d74416ae18ab86e1fb4a12e4c",
    "KBPvK.rtbz": "0360472b5800b9c5fbecf4717b0ef582e503bcdee16f57ee8e187234a80a5581",
    "KBvK.rtbw": "bc0d8ab3560de9038460f0e8f61e3b7efd3e3d0327d19ae0387c0da7ddeb244d",
    "KBvK.rtbz": "6246c8a5c643eec9d4758d55ed843e31cc28a9b82a6f630c1c950d8b7755975b",
    "KBvKB.rtbw": "f0bfff470a9775c0f6693d7c1b73a0879cfed64f9b50cb56872cc15dbe8336ad",
    "KBvKB.rtbz": "104404c12c01bbeef4e9095a65cf1f98da6def2e106880b555371f3a8c7f54b6",
    "KBvKN.rtbw": "1d0c01bfb86b5167103f5e46eaa9cfda8b614424cd7749b5e02539c850594bda",
    "KBvKN.rtbz": "268eecbf84f5371a860707ef55a7c53fc55e7c5d29379ec70d6b7ff253d48d2e",
    "KBvKP.rtbw": "7ea5491c17771a47cb558bf3ac3d6fe6a85e2075daa34f8ec4fa91b4319c1fe5",
    "KBvKP.rtbz": "929287a203a8f371f2418cfcbd4b05638a7dc7d2146b87df07a6259b653aebee",
    "KNNvK.rtbw": "8b5195abd7f1d4be7aa4b4dca669e9075d61d1c6b02dec8b71f5e9ea21d9eced",
    "KNNvK.rtbz": "9b2f7f8046cc7911c82a6d51abfa405dfd1c35f118f9a0705e69bd9f81db12ce",
    "KNPvK.rtbw": "27ce7e0ea8f585dfbbb29e2cc1e04ac547818d547c17ad9b053b05eca6f5b479",
    "KNPvK.rtbz": "b2543f1e060eb800cb5f3dc8968c6c57141a87819039d29d681ab3cd2386c57c",
    "KNvK.rtbw": "9d3518b12df3d2006441df758bce31e961346e70a11920aaad75c647003bb6e7",
    "KNvK.rtbz": "0e49a0f2810a131c32fc14872e83044aa9810ce2c86df071851512077291fc25",
    "KNvKN.rtbw": "290b5d295f531ac680e35a3295ff265e89da864fc0363b5d7aca928c8e38faf6",
    "KNvKN.rtbz": "540abbc141be6619646d1ad9cd3080c97e52eb599e3a5832974f93d2d5114f9d",
    "KNvKP.rtbw": "f21332cc4b380764847d6c32511dee16cbf56e65604596ca24e784f8e4c13bdb",
    "KNvKP.rtbz": "f5540325bc8bb6b2a9c99b9e1f4672aa06291fd2d8a4d2fa1fbd9453c90774b4",
    "KPPvK.rtbw": "55aa91c460bc5eea322b8a6cde4f94d2e0a244b6fc14f6aca17e6ccfb2e56ef6",
    "KPPvK.rtbz": "a56cb0a0fd1baa54a47f14b383a8bb0e74051832fbd7f12a0a47f09e5e68b370",
    "KPvK.rtbw": "02fd2bdcd92821c869458f019f63524def1c9e7a2862ca8d2b16dc7712b16183",
    "KPvK.rtbz": "ad01af2076183c90ccee662ca6c5d74da3222ff1fee47c01b5d4e56ed01938de",
    "KPvKP.rtbw": "6d21860e47a91d00841ccf63a657dc09b78f602e0ec005f925470e2449e1ae05",
    "KPvKP.rtbz": "2967707c971ec847c5ef3fe6f1934166aeb10c8cc151a1ae9d7c922c5aed1fc3",
    "KQBvK.rtbw": "55948e960dcdf6b4f02ebae87b1a1a7d14bff085aea17e6e6d4b7f75a2306493",
    "KQBvK.rtbz": "27b12f2c8083962b502704af7fd01d7424bfbe724c2bbfd6962f227c7fe91732",
    "KQNvK.rtbw": "cd807df1b6f5966ddc9f481e01bd58b4653d67c77d9d450d348c9bca827b51b8",
    "KQNvK.rtbz": "a86a0900d84c4c95bb85845b88f3ff77ef50383593fa27383ed2e585e8d8139c",
    "KQPvK.rtbw": "e7cd0729a1b2662f289d423bf788634d60a0fb86e11b0b791da9ab88a36a8e6f",
    "KQPvK.rtbz": "b8a0ddb251a9368c4a97f7add8647b050fb0257ed6bea5cf1dc3a720994082c4",
    "KQQvK.rtbw": "b1c0d3eabf1226440b950fd468c4f30a13ea69ce38194bc65e07bd6b617226e0",
    "KQQvK.rtbz": "0d8e14a93ba2fd578b904746c5b0d0c93eb7084aff654c72a0476cab00ba6f94",
    "KQRvK.rtbw": "b018ece9cc195618981b027268f9cca929a1ed4c0bdd739874b7846640ef479a",
    "KQRvK.rtbz": "9766d3e684582297943583e1981154609655034cea2aa78a5494cc01c8c6bcee",
    "KQvK.rtbw": "517667dff787162dbb1ed9d5d6484d30ee854e686ee0675c08d99ecf045d2d50",
    "KQvK.rtbz": "71ea9444fa5bd42897d781a0c356975ea6f23e0f65a4254e470897031c161c8c",
    "KQvKB.rtbw": "0c18bbcaec0e7c161d56392ff57a39258dd93acd0321e3bbb32f7c05636abeac",
    "KQvKB.rtbz": "a63befd64dbd1aab4e8b290da558fa1ccae21d7aebad81966a7cdd6ac8432554",
    "KQvKN.rtbw": "ba07bd47c6eaa20904b595f43e171c6fc70fcc056cb33696fe12ed254c546100",
    "KQvKN.rtbz": "0e99385bbd903975f8511751379079aa3b6663dd093f43b9ac951a97bd938371",
    "KQvKP.rtbw": "2f92788170e8a5c05608f44a47fd42f3f4fff372d0af64633c56bd081039d8f9",
    "KQvKP.rtbz": "faedb2db23be6619a57cd21c1291582bba9ddae30c5a394f5d4a7ab834a3940f",
    "KQvKQ.rtbw": "571a85d86e635e48567997ea648fd1e90dde39c9b413b2fe968f5e7faeacfbb0",
    "KQvKQ.rtbz": "98327247ba50c403199faec4df4a5f21e333c5c51b6ea2649ef9fd71264f8344",
    "KQvKR.rtbw": "8cdbe3c8e098037875de5854c656f8afeadb8327c85b5b7b1cac81719afd3e2c",
    "KQvKR.rtbz": "0c15a2aaa3bdef39da4c26932006b5d38b55b8e3ad13e8a44815d63f84738618",
    "KRBvK.rtbw": "9e6eced11a37cad71b4fc1a4f62a15e191e58883b51ce8c4c45f341051c6ae8e",
    "KRBvK.rtbz": "e3bb6fbd54a57a154136ecee763a8e9862d8ab3f57b2f55387df70bdbff1b140",
    "KRNvK.rtbw": "4f96cab9fc0005f2679eacb92cec32edf9c932db7bb29b5dc7659be0012d6c35",
    "KRNvK.rtbz": "150b85874a78474a38d0f36f1ab39d387f524a1c2092ad92d3d0945d96c17d16",
    "KRPvK.rtbw": "6bc2aa9db5ee7fcc287e6c3b006ab6cfc2be4dff4ae7ca4a524a78520eea61db",
    "KRPvK.rtbz": "5c89c9ef70c144bb2d6d823a41668ccf2f79b486b6bc128ff01aadb5485c06a9",
    "KRRvK.rtbw": "4c05ec32e6e43b690d235307de75432a3ceecdbc3d2659d8101ed15b48b8445d",
    "KRRvK.rtbz": "e68314e00bf9f16122005a06f7d42bc0f6c682f30e8ca50532ba44444f3b96ce",
    "KRvK.rtbw": "386fbde73308e49a4207836922c68b30b664e83c5a37f7fa37305a15cd16f2f1",
    "KRvK.rtbz": "cab59f42e75c2a25da3939231850a79fa838593fff5c28d7772da92062ed965a",
    "KRvKB.rtbw": "69b247cb390ffcd729cf5fe5c40f8a24803190bf67b108b8f05b8b08b26a6a72",
    "KRvKB.rtbz": "4fa644478a516e1425b22a740ddefc4d54e51298250b8208d26073df3638630b",
    "KRvKN.rtbw": "a8cde902b010bf6c8763c97d19b5430b422e74db9cb8e9d5e67fa07373c13c5b",
    "KRvKN.rtbz": "c0df57d0b066cdd7be5bdf9b14745f6ead1fd8e9fba2b77fe0f3cb56ebef7ae0",
    "KRvKP.rtbw": "3968c2bfced3a5ecfbb54166ec13d4e7b70f3b03c495af4ae87cad2ec75a0749",
    "KRvKP.rtbz": "6d4b1389832854119df815ff89ed2cb0786e8887f000009f0db3484457f7f6ff",
    "KRvKR.rtbw": "797081b5b3fbac20c4baa5453d68bdae1425b63895f5c9a5ac5c68ea63a97712",
    "KRvKR.rtbz": "c23fa5a0209204b847232ed49e079c099cf603b43d6ace9e27257793b1839850",
}

# platform.machine() spells the same processor several ways
MACHINES = {"amd64": "x86_64", "x86_64": "x86_64", "x64": "x86_64",
            "arm64": "arm64", "aarch64": "arm64", "riscv64": "riscv64"}


def fetch(url):
    """The bytes at url. The certificate is still verified; only Python 3.13's strict RFC 5280 profile
    is dropped: networks that inspect TLS (a university's, an antivirus') often issue CA certificates
    it refuses ("Basic Constraints ... not marked critical"). A pinned SHA-256 vouches for every file."""
    ctx = ssl.create_default_context()
    ctx.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)
    with urllib.request.urlopen(url, timeout=300, context=ctx) as r:
        return r.read()


def asset():
    key = (platform.system().lower(), MACHINES.get(platform.machine().lower(), platform.machine().lower()))
    if key not in ASSETS:
        raise SystemExit("No Stockfish 19 release build for %s/%s; build it from source and pass its path." % key)
    return ASSETS[key]


def answers_as_19(path):
    """The UCI handshake: True when the binary names itself Stockfish 19."""
    try:
        out = subprocess.run([path], input="uci\nquit\n", capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return False
    return any(line.startswith("id name " + VERSION) for line in out.splitlines())


def installed():
    """The installed binary's path, or None. Only a binary that answers as Stockfish 19 counts."""
    if not os.path.isdir(HOME):
        return None
    for name in sorted(os.listdir(HOME)):
        path = os.path.join(HOME, name)
        if os.path.isfile(path) and name.startswith("stockfish") and not name.endswith((".zip", ".gz")):
            if answers_as_19(path):
                return path
    return None


def unpack(name, data):
    """The binary out of the archive, by itself: the release also carries the source and the nets' licence."""
    members = []
    if name.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            members = [(i.filename, z.read(i)) for i in z.infolist() if not i.is_dir()]
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
            members = [(m.name, t.extractfile(m).read()) for m in t.getmembers() if m.isfile()]
    # The binary is the top-level stockfish-<os>-<arch>... file, not anything under src/ or wiki/
    picks = [(n, b) for n, b in members
             if os.path.basename(n).startswith("stockfish") and "/src/" not in "/" + n
             and not n.endswith((".md", ".txt", ".nnue"))]
    if len(picks) != 1:
        raise SystemExit("Expected one Stockfish binary in %s, found: %s" % (name, [n for n, _ in picks] or "none"))
    member, body = picks[0]
    os.makedirs(HOME, exist_ok=True)
    out = os.path.join(HOME, os.path.basename(member))   # basename only: no path in the archive is trusted
    with open(out, "wb") as f:
        f.write(body)
    os.chmod(out, os.stat(out).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return out


def install():
    have = installed()
    if have:
        print(have)
        return have
    name, sha = asset()
    print("Downloading %s (about 80 MB) from the official release..." % name, file=sys.stderr)
    data = fetch(RELEASE + name)
    got = hashlib.sha256(data).hexdigest()
    if got != sha:
        raise SystemExit("%s does not match the release's SHA-256 (got %s, want %s); nothing was installed." % (name, got, sha))
    if os.path.isdir(HOME):
        shutil.rmtree(HOME)   # a binary that failed the handshake, left from an earlier attempt
    path = unpack(name, data)
    if not answers_as_19(path):
        shutil.rmtree(HOME)
        raise SystemExit("The unpacked binary did not answer the UCI handshake as %s; nothing was installed." % VERSION)
    print(path)
    return path


def sha256_of(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def syzygy():
    """The tablebase folder, or None: only when every pinned file is there with its pinned SHA-256."""
    ok = all(os.path.isfile(os.path.join(SYZYGY_HOME, n)) and sha256_of(os.path.join(SYZYGY_HOME, n)) == h
             for n, h in SYZYGY.items())
    return SYZYGY_HOME if ok else None


def install_syzygy():
    if syzygy():
        return SYZYGY_HOME
    os.makedirs(SYZYGY_HOME, exist_ok=True)
    print("Downloading the 3- and 4-piece Syzygy tablebases (4.3 MB)...", file=sys.stderr)
    for name, sha in sorted(SYZYGY.items()):
        path = os.path.join(SYZYGY_HOME, name)
        if os.path.isfile(path) and sha256_of(path) == sha:
            continue
        data = fetch(SYZYGY_URL % ("wdl" if name.endswith(".rtbw") else "dtz") + name)
        if hashlib.sha256(data).hexdigest() != sha:
            raise SystemExit("%s does not match its pinned SHA-256; it was not kept." % name)
        with open(path, "wb") as f:
            f.write(data)
    return SYZYGY_HOME


if __name__ == "__main__":
    if "--path" in sys.argv[1:]:
        p = installed()
        if not p:
            raise SystemExit("Stockfish 19 is not installed; run python tools/install_stockfish.py")
        print(p)
    elif "--syzygy" in sys.argv[1:]:
        p = syzygy()
        if not p:
            raise SystemExit("The Syzygy tables are not installed; run python tools/install_stockfish.py")
        print(p)
    else:
        install()
        install_syzygy()
