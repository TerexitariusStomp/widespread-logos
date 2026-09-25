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

if(MINGW OR WIN32)
    # These must sit AFTER logos_module() so they land at the END of the link
    # line — liblogos_protocol.a and the Qt archives (added by the macro)
    # carry the same libstdc++ undefineds, and GNU ld only looks backward.
    #
    # The Rust staticlib bundles C++ objects (witness-generator, rapidsnark)
    # that need the C++ runtime; rustls-platform-verifier's Schannel path
    # wants the certificate store API (crypt32); and the rapidsnark objects
    # were built against winpthreads — which nixpkgs' mingw sysroot lacks (it
    # builds against mcfgthread), so the flake's windows cross package ships
    # the static archive alongside libwidespread_wallet.a for us to link by
    # staged path.
    set(_wsp_win_link_libs
        crypt32
        gcc gcc_eh mingw32 moldname mingwex msvcrt
        kernel32 user32 advapi32 shell32 ws2_32 bcrypt ntdll userenv
        synchronization
    )
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/lib/libwinpthread.a")
        list(PREPEND _wsp_win_link_libs
            "${CMAKE_CURRENT_SOURCE_DIR}/lib/libwinpthread.a")
    endif()
    # nixpkgs' mingw libstdc++.a is dllimport-flavored: the vtables, typeinfo
    # and std::system_error ctor exist only inside libstdc++-6.dll, and the
    # toolchain ships no libstdc++.dll.a import library. GNU ld accepts a DLL
    # as a linker input directly and synthesizes the __imp_*/.refptr.* symbols
    # from its export table, so the flake stages the runtime DLL beside our
    # staticlib and we link it by path. The builder's win-dll-link postFixup
    # then ships the DLL next to the plugin.
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/lib/libstdc++-6.dll")
        list(APPEND _wsp_win_link_libs
            "${CMAKE_CURRENT_SOURCE_DIR}/lib/libstdc++-6.dll")
    else()
        list(APPEND _wsp_win_link_libs stdc++)
    endif()
    target_link_libraries(widespread_wallet_module_plugin PRIVATE
        ${_wsp_win_link_libs})
    # --enable-auto-import: objects compiled dllimport-style emit .refptr.*
    # refs that ld only synthesizes under auto-import.
    target_link_options(widespread_wallet_module_plugin PRIVATE
        -static-libgcc -Wl,--enable-auto-import)
endif()
