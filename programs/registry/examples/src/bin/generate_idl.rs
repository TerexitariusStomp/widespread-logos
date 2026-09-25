/// Generate IDL JSON for the registry program.
///
/// Usage:
///   cargo run --bin generate_idl > registry-idl.json

spel_framework::generate_idl!("../methods/guest/src/bin/registry.rs");
