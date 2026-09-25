build:
	cargo risczero build --manifest-path methods/guest/Cargo.toml

idl: build
	cargo run -p pointer-examples --bin generate_idl

.PHONY: build idl
