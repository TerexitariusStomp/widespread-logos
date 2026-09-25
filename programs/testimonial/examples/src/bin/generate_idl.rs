/// Generate IDL JSON for the testimonial program.
///
/// Usage:
///   cargo run --bin generate_idl > testimonial-idl.json

spel_framework::generate_idl!("../methods/guest/src/bin/testimonial.rs");
