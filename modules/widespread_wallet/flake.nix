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
    nix-bundle-lgx.url = "github:logos-co/nix-bundle-lgx";

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
      # where upstream publishes both — identical constraint to the faucet
      # module this flake is adapted from. x86_64-darwin is absent on purpose:
      # logos-blockchain-circuits v0.5.3 publishes no macOS x86_64 archive.
      #
      # Hash values match faucet-module/flake.nix — same circuits v0.5.3 and
      # rust-rapidsnark e91187f8 pins, verified from this repo's Cargo.lock.
      rapidsnarkVersion = "v0.0.8";
      iden3Base = "https://github.com/iden3/rapidsnark/releases/download/${rapidsnarkVersion}";
      picBase = "https://github.com/logos-blockchain/logos-blockchain-rust-rapidsnark/releases/download/rapidsnark-pic-${rapidsnarkVersion}";

      prebuilt = {
        aarch64-darwin = {
          circuitsPlatform = "macos-aarch64";
          circuitsHash = "0w3i0phgzjswsk1q2k6cr3001jjc55a82z79zw9w5p3x9hwaqljq";
          rapidsnarkUrl = "${iden3Base}/rapidsnark-macOS-arm64-${rapidsnarkVersion}.zip";
          rapidsnarkHash = "1600dzr7hjg6lc5r0cdh189l7019djvy4cz2qyn75z5vrac4qs0f";
        };
        x86_64-linux = {
          circuitsPlatform = "linux-x86_64";
          circuitsHash = "1mwy3g9dyjvlwykzs62gzf79rrnm20sy7c587nv26c1y9bm71wfv";
          rapidsnarkUrl = "${picBase}/rapidsnark-linux-x86_64-pic-${rapidsnarkVersion}.zip";
          rapidsnarkHash = "07qdnh4lm99alkmmg3av916bma7s86s616s56y0j4q4h82897kzk";
        };
        aarch64-linux = {
          circuitsPlatform = "linux-aarch64";
          circuitsHash = "14r4vghipk66k8g22kymy2gpfa1ghwwa74v57a230yk0pm9zvgp7";
          rapidsnarkUrl = "${picBase}/rapidsnark-linux-aarch64-pic-${rapidsnarkVersion}.zip";
          rapidsnarkHash = "15f4iqy2szqpp84v8584s5b86vw8rfz60wx7h7ylp34r0m7qii4i";
        };
      };

      systems = builtins.attrNames prebuilt;

      # Workspace members needed to build the module crate — manifests of
      # every member must exist for cargo to resolve, so the filter keeps all
      # of crates/ and modules/ plus the root manifest and lockfile.
      walletSource = lib.cleanSourceWith {
        name = "widespread-wallet-source";
        src = widespread-src;
        filter = path: type:
          let
            sourcePath = toString path;
            baseName = builtins.baseNameOf sourcePath;
          in
          baseName == "Cargo.toml"
          || baseName == "Cargo.lock"
          || lib.hasInfix "/crates/" sourcePath
          || lib.hasInfix "/modules/" sourcePath;
      };

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
            url = "https://github.com/logos-blockchain/logos-blockchain-circuits/releases/download/v0.5.3/logos-blockchain-circuits-v0.5.3-${artifacts.circuitsPlatform}.tar.gz";
            sha256 = artifacts.circuitsHash;
          };

          rapidsnark = pkgs.fetchzip {
            url = artifacts.rapidsnarkUrl;
            sha256 = artifacts.rapidsnarkHash;
          };

          # The crate is a staticlib — the generated Qt glue links the archive
          # and picks up the module-impl C ABI symbols from it.
          libFile = "libwidespread_wallet.a";

          # Patched crates.io vendor fetcher — verbatim from
          # lez-faucet/faucet-module/flake.nix (User-Agent 403 fix, 429 retry
          # widening, static.crates.io CDN endpoint). See that file for the
          # full measured rationale; the substitutions are asserted so a
          # nixpkgs bump that reshapes the fetcher fails loudly.
          fetchCargoVendorPatched =
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
                   (builtins.readFile "${rustBuildSupport}/fetch-cargo-vendor-util.py"))));
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
            hash = lib.fakeHash; # TODO(ci): first build prints the real hash
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

      walletLib = lib.genAttrs systems walletLibFor;

      walletLibInput = {
        packages = lib.mapAttrs (_system: drv: { default = drv; }) walletLib;
      };

      base = logos-module-builder.lib.mkLogosModule {
        src = ./.;
        configFile = ./metadata.json;
        flakeInputs = inputs;
        externalLibInputs.widespread_wallet = {
          input = walletLibInput;
          packages.default = "default";
        };
      };
    in
    base // {
      # Publish only systems the prebuilt table can satisfy — absent beats
      # present-and-broken (see faucet flake for the same reasoning).
      packages = lib.genAttrs systems (system:
        (base.packages.${system} or {}) // {
          widespread_wallet = walletLib.${system};
        });
    } // lib.optionalAttrs (base ? checks) {
      checks = lib.genAttrs systems (system: base.checks.${system} or {});
    };
}
