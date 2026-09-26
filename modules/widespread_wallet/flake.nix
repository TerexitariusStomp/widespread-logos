{
  description = "Widespread Wallet — LEZ wallet Basecamp core module";

  inputs = {
    logos-module-builder.url = "github:logos-co/logos-module-builder";

    # The packaging tool, and the one input whose staleness is silent. Its
    # bundle.sh copies metadata.json's descriptive fields into the bundled
    # manifest.json through a hand-written key allowlist, so a pin that
    # predates a key drops that key with no build failure and no test failure
    # (logos-co/eth-lez-atomic-swaps#60). Keep it current; the durable check is
    # CI's manifest round trip, not the pin.
    # Fork rev: adds "ucrtbase" to windowsSystemDlls on top of upstream main
    # (which has "winscard" but not ucrtbase). Upstream: logos-co PR #18 —
    # drop the fork once it lands.
    nix-bundle-lgx.url =
      "github:TerexitariusStomp/nix-bundle-lgx/9ba9fb320c3b0514fb85bbe3ae9839ea0b593907";
    # The builder constructs the windows payload gate with ITS OWN lgx pin;
    # redirect it so the gate sees the winscard+ucrtbase entries.
    logos-module-builder.inputs.nix-bundle-lgx.follows = "nix-bundle-lgx";

    nixpkgs.follows = "logos-module-builder/nixpkgs";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    logos-execution-zone = {
      # Pinned to the deployed testnet protocol tag the workspace pins.
      url = "github:logos-blockchain/logos-execution-zone/v0.2.4";
      flake = false;
    };
    # Repo root: the module crate is a workspace member and its deps live in
    # crates/, so the flake source spans the repository, not just this dir.
    widespread-src = {
      url = "path:../..";
      flake = false;
    };
  };

  outputs = inputs@{
    logos-module-builder,
    nixpkgs,
    rust-overlay,
    logos-execution-zone,
    widespread-src,
    ...
  }:
    let
      lib = nixpkgs.lib;

      # The LEZ client stack links prebuilt, per-platform circuit and
      # rapidsnark archives, so this module can only be built for a system
      # where a compatible archive is published.
      #
      # x86_64-darwin uses TerexitariusStomp/logos-blockchain-circuits — the
      # fork adds a macos-15-intel CI leg (upstream never published an
      # Intel-Mac bundle); an upstream PR is filed so this can move back to
      # the canonical repo once merged. rapidsnark-macOS-x86_64 comes from
      # iden3's own release, which always shipped it.
      #
      # Other hash values match faucet-module/flake.nix — same circuits
      # v0.5.3 and rust-rapidsnark e91187f8 pins, verified from Cargo.lock.
      rapidsnarkVersion = "v0.0.8";
      iden3Base = "https://github.com/iden3/rapidsnark/releases/download/${rapidsnarkVersion}";
      picBase = "https://github.com/logos-blockchain/logos-blockchain-rust-rapidsnark/releases/download/rapidsnark-pic-${rapidsnarkVersion}";
      upstreamCircuitsBase = "https://github.com/logos-blockchain/logos-blockchain-circuits/releases/download/v0.5.3";
      forkCircuitsBase = "https://github.com/TerexitariusStomp/logos-blockchain-circuits/releases/download/v0.5.3";

      prebuilt = {
        aarch64-darwin = {
          circuitsPlatform = "macos-aarch64";
          circuitsBase = upstreamCircuitsBase;
          circuitsHash = "0w3i0phgzjswsk1q2k6cr3001jjc55a82z79zw9w5p3x9hwaqljq";
          rapidsnarkUrl = "${iden3Base}/rapidsnark-macOS-arm64-${rapidsnarkVersion}.zip";
          rapidsnarkHash = "1600dzr7hjg6lc5r0cdh189l7019djvy4cz2qyn75z5vrac4qs0f";
        };
        x86_64-darwin = {
          circuitsPlatform = "macos-x86_64";
          circuitsBase = forkCircuitsBase;
          circuitsHash = "sha256-FRvwX/bGkuZ+ru2ChETiwhLnCHN2NKCqSTGEybPa0U4=";
          rapidsnarkUrl = "${iden3Base}/rapidsnark-macOS-x86_64-${rapidsnarkVersion}.zip";
          rapidsnarkHash = "sha256-/GCXzzT5mkBeXkVQAGEF9OmJXXcYz4KoXNzjFvhSgNU=";
        };
        x86_64-linux = {
          circuitsPlatform = "linux-x86_64";
          circuitsBase = upstreamCircuitsBase;
          circuitsHash = "1mwy3g9dyjvlwykzs62gzf79rrnm20sy7c587nv26c1y9bm71wfv";
          rapidsnarkUrl = "${picBase}/rapidsnark-linux-x86_64-pic-${rapidsnarkVersion}.zip";
          rapidsnarkHash = "07qdnh4lm99alkmmg3av916bma7s86s616s56y0j4q4h82897kzk";
        };
        aarch64-linux = {
          circuitsPlatform = "linux-aarch64";
          circuitsBase = upstreamCircuitsBase;
          circuitsHash = "14r4vghipk66k8g22kymy2gpfa1ghwwa74v57a230yk0pm9zvgp7";
          rapidsnarkUrl = "${picBase}/rapidsnark-linux-aarch64-pic-${rapidsnarkVersion}.zip";
          rapidsnarkHash = "15f4iqy2szqpp84v8584s5b86vw8rfz60wx7h7ylp34r0m7qii4i";
        };
      };

      systems = builtins.attrNames prebuilt;

      # Workspace members needed to build the module crate — manifests of
      # every member must exist for cargo to resolve, so the filter keeps all
      # of crates/ and modules/ plus the root manifest and lockfile.
      # Directories must always pass: cleanSourceWith prunes a directory
      # without descending when the filter returns false, and the top-level
      # "crates"/"modules" dirs themselves don't match the "/crates/"-style
      # infixes (no trailing slash) — without this the whole trees vanish and
      # cargo can't read workspace members' manifests.
      walletSource = lib.cleanSourceWith {
        name = "widespread-wallet-source";
        src = widespread-src;
        filter = path: type:
          let
            sourcePath = toString path;
            baseName = builtins.baseNameOf sourcePath;
          in
          type == "directory"
          || baseName == "Cargo.toml"
          || baseName == "Cargo.lock"
          || lib.hasInfix "/crates/" sourcePath
          || lib.hasInfix "/modules/" sourcePath;
      };

      # Patched crates.io vendor fetcher — verbatim from
      # lez-faucet/faucet-module/flake.nix (User-Agent 403 fix, 429 retry
      # widening, static.crates.io CDN endpoint). See that file for the
      # full measured rationale; the substitutions are asserted so a
      # nixpkgs bump that reshapes the fetcher fails loudly.
      mkFetchCargoVendorPatched = pkgs: rustToolchain:
        let
          rustBuildSupport = "${nixpkgs}/pkgs/build-support/rust";
          subst = what: from: to: text:
            let out = builtins.replaceStrings [ from ] [ to ] text; in
            if out == text
            then throw "widespread_wallet: crates.io ${what} workaround is stale — ${builtins.toJSON from} not found in nixpkgs' cargo vendor fetcher"
            else out;
          replaceWorkspaceValues = pkgs.writers.writePython3Bin "replace-workspace-values" {
            libraries = with pkgs.python3Packages; [ tomli tomli-w ];
            flakeIgnore = [ "E501" "W503" ];
          } (builtins.readFile "${rustBuildSupport}/replace-workspace-values.py");
          fetchCargoVendorUtil = pkgs.writers.writePython3Bin "fetch-cargo-vendor-util" {
            libraries = with pkgs.python3Packages; [ requests ];
            flakeIgnore = [ "E501" ];
          } (subst "User-Agent"
               "    session = requests.Session()\n"
               "    session = requests.Session()\n    session.headers[\"User-Agent\"] = \"nixpkgs-fetchCargoVendor/1 (https://github.com/NixOS/nixpkgs)\"\n"
            (subst "429 retry"
               "        total=5,\n        backoff_factor=0.5,\n        status_forcelist=[500, 502, 503, 504]\n"
               "        total=12,\n        backoff_factor=1.5,\n        backoff_jitter=1.0,\n        backoff_max=60,\n        respect_retry_after_header=True,\n        status_forcelist=[429, 500, 502, 503, 504]\n"
            (subst "static.crates.io download"
               "    return f\"https://crates.io/api/v1/crates/{pkg[\"name\"]}/{pkg[\"version\"]}/download\"\n"
               "    return f\"https://static.crates.io/crates/{pkg[\"name\"]}/{pkg[\"name\"]}-{pkg[\"version\"]}.crate\"\n"
            # lee_core-0.1.0 appears in the lockfile twice — upstream tag (via
            # spel-framework-core's hardcoded git dep, which [patch] cannot
            # redirect) and the keycard-gate fork branch. Sources are
            # byte-identical (the branch only touches lez/wallet), so merging
            # the vendor dir is safe.
            (subst "git-crate dup-source guard"
               "    shutil.copytree(crate_tree, crate_out_dir, ignore=ignore_func)\n"
               "    if crate_out_dir.exists():\n        eprint(f\"Vendor dir {crate_out_dir} already exists (duplicate git source), skipping\")\n    else:\n        shutil.copytree(crate_tree, crate_out_dir, ignore=ignore_func)\n"
               (builtins.readFile "${rustBuildSupport}/fetch-cargo-vendor-util.py")))));
        in
        { name, hash, ... }@args:
        let
          vendorStaging = pkgs.stdenvNoCC.mkDerivation ({
            name = "${name}-vendor-staging";

            impureEnvVars = lib.fetchers.proxyImpureEnvVars;

            nativeBuildInputs = [
              fetchCargoVendorUtil
              pkgs.cacert
              (pkgs.nix-prefetch-git.override { git-lfs = null; })
            ];

            buildPhase = ''
              runHook preBuild
              fetch-cargo-vendor-util create-vendor-staging ./Cargo.lock "$out"
              runHook postBuild
            '';

            strictDeps = true;
            dontConfigure = true;
            dontInstall = true;
            dontFixup = true;

            outputHash = hash;
            outputHashMode = "recursive";
          } // builtins.removeAttrs args [ "name" "hash" ]);
        in
        pkgs.runCommand "${name}-vendor"
          {
            inherit vendorStaging;
            nativeBuildInputs = [ fetchCargoVendorUtil rustToolchain replaceWorkspaceValues ];
          }
          ''
            fetch-cargo-vendor-util create-vendor "$vendorStaging" "$out"
          '';

      walletLibFor = system:
        let
          artifacts = prebuilt.${system};
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ (import rust-overlay) ];
          };
          rustToolchain = pkgs.rust-bin.stable."1.93.0".default;
          rustPlatform = pkgs.makeRustPlatform {
            cargo = rustToolchain;
            rustc = rustToolchain;
          };

          circuits = pkgs.fetchzip {
            url = "${artifacts.circuitsBase}/logos-blockchain-circuits-v0.5.3-${artifacts.circuitsPlatform}.tar.gz";
            sha256 = artifacts.circuitsHash;
          };

          rapidsnark = pkgs.fetchzip {
            url = artifacts.rapidsnarkUrl;
            sha256 = artifacts.rapidsnarkHash;
          };

          # The crate is a staticlib — the generated Qt glue links the archive
          # and picks up the module-impl C ABI symbols from it.
          libFile = "libwidespread_wallet.a";

          fetchCargoVendorPatched = mkFetchCargoVendorPatched pkgs rustToolchain;
        in
        rustPlatform.buildRustPackage {
          pname = "widespread_wallet";
          version = "0.1.0";
          src = walletSource;
          # Tracks Cargo.lock byte-for-byte — REGENERATE on any lockfile move:
          # set lib.fakeHash, build, take the `got:` value from the mismatch.
          cargoDeps = fetchCargoVendorPatched {
            name = "widespread_wallet-0.1.0";
            src = walletSource;
            hash = "sha256-bxQRGNmO5TAMFIhRSG0M6VXJCan87tqXJ2blu4YrCho=";
          };
          cargoBuildFlags = [ "-p" "widespread_wallet" ];
          doCheck = false;

          # pcsc-sys (keycard_wallet) finds libpcsclite via pkg-config.
          nativeBuildInputs = [ pkgs.pkg-config pkgs.python3 ];
          # pkg-config's setup hook exports PKG_CONFIG_PATH covering this.
          buildInputs = [ pkgs.pcsclite ];

          LBC_ROOT_DIR = circuits;
          RAPIDSNARK_LIB_DIR = "${rapidsnark}/lib";

          # build_utils resolves ../artifacts relative to its vendored
          # manifest — stage the committed builtin-program artifacts from the
          # pinned upstream LEZ rev beside it.
          postPatch = ''
            cp -R ${logos-execution-zone}/artifacts "$cargoDepsCopy/artifacts"
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib
            ffi_lib=$(find target -name ${libFile} -print -quit)
            if [ -z "$ffi_lib" ]; then
              echo "widespread_wallet build did not produce ${libFile}" >&2
              exit 1
            fi
            cp "$ffi_lib" $out/lib/${libFile}
            runHook postInstall
          '';
        };

      # Windows is not a nixpkgs host platform — the module is cross-compiled
      # from a Linux build host via pkgsCross.mingwW64. The circuits bundle
      # ships upstream (windows-x86_64); the rapidsnark archive is the
      # MinGW-w64 static build produced by the fork's build-pic-archives
      # workflow (upstream rust-rapidsnark has no Windows target support).
      windowsCrossFor = system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ (import rust-overlay) ];
          };
          crossPkgs = pkgs.pkgsCross.mingwW64;
          rustToolchain = pkgs.rust-bin.stable."1.93.0".default.override {
            targets = [ "x86_64-pc-windows-gnu" ];
          };
          rustPlatform = crossPkgs.makeRustPlatform {
            cargo = rustToolchain;
            rustc = rustToolchain;
          };

          # The windows bundle ships `pol.lib`-style names (MSVC convention);
          # rustc on windows-gnu only searches `lib{name}.a`, so rename the
          # GNU ar archives to what the linker expects.
          circuits = pkgs.runCommand "lbc-circuits-windows" { } ''
            cp -R ${pkgs.fetchzip {
              url = "${forkCircuitsBase}/logos-blockchain-circuits-v0.5.3-windows-x86_64.tar.gz";
              sha256 = "sha256-6pTxqVkkUr6/s58u+8/r63pDimOA2hcQwxWpPp3IY2o=";
            }} "$out"
            chmod -R +w "$out"
            for f in "$out"/*/*.lib; do
              mv "$f" "$(dirname "$f")/lib$(basename "$f" .lib).a"
            done
          '';

          rapidsnark = pkgs.fetchzip {
            url = "https://github.com/TerexitariusStomp/logos-blockchain-rust-rapidsnark/releases/download/rapidsnark-pic-${rapidsnarkVersion}/rapidsnark-windows-x86_64-pic-${rapidsnarkVersion}.zip";
            sha256 = "sha256-MDrd1N36b5ZSq+g2ZOGXXiC1FMuULJgNi51GKXIKOiw=";
          };

          libFile = "widespread_wallet.lib";

          # Where the mingw toolchain keeps its runtime DLLs — nixpkgs spreads
          # them across the unwrapped cross gcc's outputs. (crossPkgs.gcc is a
          # windows-HOST gcc that refuses to even evaluate here; stdenv.cc.cc
          # is the cross compiler that built our objects.)
          mingwRtDirs = lib.unique (builtins.filter (p: p != null) [
            (lib.attrByPath [ "stdenv" "cc" "cc" ] null crossPkgs)
            (lib.attrByPath [ "stdenv" "cc" "cc" "lib" ] null crossPkgs)
            (lib.attrByPath [ "windows" "mingw_w64" ] null crossPkgs)
          ]);
        in
        rustPlatform.buildRustPackage {
          pname = "widespread_wallet-windows";
          version = "0.1.0";
          src = walletSource;
          cargoDeps = mkFetchCargoVendorPatched pkgs rustToolchain {
            name = "widespread_wallet-0.1.0";
            src = walletSource;
            hash = "sha256-bxQRGNmO5TAMFIhRSG0M6VXJCan87tqXJ2blu4YrCho=";
          };
          cargoBuildFlags = [ "-p" "widespread_wallet" ];
          doCheck = false;
          # Guest zkVM programs are not built under cross — matches CI's
          # RISC0_SKIP_BUILD usage.
          RISC0_SKIP_BUILD = "1";
          nativeBuildInputs = [ pkgs.pkg-config pkgs.python3 ];
          LBC_ROOT_DIR = circuits;
          RAPIDSNARK_LIB_DIR = "${rapidsnark}/lib";
          postPatch = ''
            cp -R ${logos-execution-zone}/artifacts "$cargoDepsCopy/artifacts"
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib
            ffi_lib=$(find target -name ${libFile} -o -name libwidespread_wallet.a | head -1)
            if [ -z "$ffi_lib" ]; then
              echo "widespread_wallet build did not produce a windows static lib" >&2
              exit 1
            fi
            cp "$ffi_lib" $out/lib/
            # The rapidsnark objects merged into the staticlib call
            # pthread_mutex_* — winpthreads, which the module plugin link
            # cannot see (nixpkgs mingw builds against mcfgthread, so no
            # -lpthread exists on its sysroot). Ship the static archive in
            # the same lib/ dir the builder stages next to the module; the
            # module CMakeLists links it by path.
            cp ${crossPkgs.windows.pthreads}/lib/libwinpthread.a $out/lib/
            # nixpkgs' mingw libstdc++.a is dllimport-flavored — its vtables,
            # typeinfo and std::system_error ctor live only in libstdc++-6.dll,
            # and the toolchain ships no .dll.a import library. GNU ld links a
            # DLL directly, so stage it where the module CMakeLists can link it
            # by path; the builder's win-dll-link postFixup then ships it next
            # to the plugin.
            stdcdll=""
            for p in ${lib.concatStringsSep " " mingwRtDirs}; do
              stdcdll=$(find "$p" -name 'libstdc++-6.dll' -print -quit)
              [ -n "$stdcdll" ] && break
            done
            if [ -z "$stdcdll" ]; then
              echo "libstdc++-6.dll not found in the mingw toolchain outputs" >&2
              exit 1
            fi
            cp "$stdcdll" $out/lib/
            runHook postInstall
          '';
        };

      walletLib = lib.genAttrs systems walletLibFor;

      walletLibInput = {
        # The builder resolves external-lib packages as
        # input.packages.<host-system>.<name>, where <name> comes from the
        # systems.*.packages.default entry below — so the windows cross
        # derivation must be exposed under that name on linux hosts.
        packages = lib.genAttrs systems (system:
          { default = walletLib.${system}; }
          // lib.optionalAttrs (lib.hasSuffix "-linux" system) {
            widespread_wallet-windows-x86_64 = windowsCrossFor system;
          });
      };

      base = logos-module-builder.lib.mkLogosModule {
        src = ./.;
        configFile = ./metadata.json;
        flakeInputs = inputs;
        externalLibInputs.widespread_wallet = {
          input = walletLibInput;
          packages.default = "default";
          # The windows build is a mingw cross derivation produced on a Linux
          # builder — it lives under packages.x86_64-linux, not a windows
          # system attr (same shape as zerokit's rln-windows-x86_64).
          systems.x86_64-windows = {
            system = "x86_64-linux";
            packages.default = "widespread_wallet-windows-x86_64";
          };
        };
      };
    in
    base // {
      # Publish only systems the prebuilt table can satisfy — absent beats
      # present-and-broken (see faucet flake for the same reasoning).
      # Additionally expose the Windows cross-build on Linux hosts.
      packages = lib.genAttrs systems (system:
        (base.packages.${system} or {}) // {
          widespread_wallet = walletLib.${system};
        } // lib.optionalAttrs (lib.hasSuffix "-linux" system) {
          widespread_wallet-windows-x86_64 = windowsCrossFor system;
        })
        # The windows-x86_64 release variant builds `.#packages.x86_64-windows.lgx-portable`
        # on a Linux runner. Absent when the pinned builder has no logos-nix —
        # guard keeps evaluation working either way.
        // lib.optionalAttrs (base.packages ? x86_64-windows) {
          x86_64-windows = base.packages.x86_64-windows;
        };
    } // lib.optionalAttrs (base ? checks) {
      checks = lib.genAttrs systems (system: base.checks.${system} or {});
    };
}
