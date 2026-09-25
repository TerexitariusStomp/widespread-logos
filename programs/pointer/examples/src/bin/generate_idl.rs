/// Generate IDL JSON for the pointer program.
///
/// Usage:
///   cargo run --bin generate_idl > pointer-idl.json

spel_framework::generate_idl!("../methods/guest/src/bin/pointer.rs");
