{
  description = "Widespread Wallet — Basecamp QML view hosting the shared wallet-ui bundle";

  inputs = {
    logos-module-builder.url = "github:logos-co/logos-module-builder";

    # See modules/widespread_wallet/flake.nix — bundle.sh allowlists manifest
    # fields, so a stale pin silently drops keys; CI's manifest round trip is
    # the durable check.
    nix-bundle-lgx.url = "github:logos-co/nix-bundle-lgx";

    # The input name must match metadata.json's dependency name.
    widespread_wallet.url = "path:../widespread_wallet";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    let
      base = logos-module-builder.lib.mkLogosQmlModule {
        src = ./.;
        configFile = ./metadata.json;
        flakeInputs = inputs;
      };
    in
    base // (
      if base ? apps then {
        apps = builtins.mapAttrs (_system: apps:
          apps // { app = apps.default; }
        ) base.apps;
      } else {}
    );
}
