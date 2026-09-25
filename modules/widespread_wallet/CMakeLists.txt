cmake_minimum_required(VERSION 3.20)
project(WidespreadWalletModule LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(DEFINED ENV{LOGOS_MODULE_BUILDER_ROOT})
    include($ENV{LOGOS_MODULE_BUILDER_ROOT}/cmake/LogosModule.cmake)
elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/cmake/LogosModule.cmake")
    include(cmake/LogosModule.cmake)
else()
    message(FATAL_ERROR "LogosModule.cmake not found. Set LOGOS_MODULE_BUILDER_ROOT.")
endif()

# No C++ SOURCES: the builder-generated cdylib glue
# (generated_code/widespread_wallet_cdylib_glue.cpp, globbed by
# LogosModule.cmake) implements the plugin entry points; the wallet logic is
# the Rust staticlib staged by flake.nix's externalLibInputs and linked via
# EXTERNAL_LIBS (static archive — no runtime copy).
logos_module(
    NAME widespread_wallet
    EXTERNAL_LIBS
        widespread_wallet
)
