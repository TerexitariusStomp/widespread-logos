PROGRAMS_DIR := methods/guest/target/riscv32im-risc0-zkvm-elf/docker

build: ## Build the guest binary (needs the risc0 toolchain)
	cargo risczero build --manifest-path methods/guest/Cargo.toml

idl: build ## Generate the program IDL
	cargo run -p testimonial-examples --bin generate_idl

.PHONY: build idl
