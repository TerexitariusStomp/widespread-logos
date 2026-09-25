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
    # as a linker input directly and synthesizes the __imp_* imports from its
    # export table, so the flake stages the runtime DLL beside our staticlib
    # and we link it by path. The builder's win-dll-link postFixup then ships
    # the DLL next to the plugin.
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/lib/libstdc++-6.dll")
        list(APPEND _wsp_win_link_libs
            "${CMAKE_CURRENT_SOURCE_DIR}/lib/libstdc++-6.dll")
    else()
        list(APPEND _wsp_win_link_libs stdc++)
    endif()
    # Late-scan pass: objects inside liblogos_protocol.a / the Qt archives sit
    # AFTER our libs on the link line, so their CRT references (fstat64i32,
    # _setjmp, SCard*) can never reach -lmsvcrt/-lwinscard placed earlier.
    # Resolve each candidate through the compiler's own search path — the same
    # mechanism ld uses for -l — and re-append the ones that exist so the
    # second occurrence satisfies the late references.
    foreach(_l winscard ucrtbase ucrt msvcrt-os msvcrt mingwex mingw32 advapi32)
        execute_process(
            COMMAND ${CMAKE_CXX_COMPILER} -print-file-name=lib${_l}.a
            OUTPUT_VARIABLE _f OUTPUT_STRIP_TRAILING_WHITESPACE)
        if(_f MATCHES "^/" AND EXISTS "${_f}")
            list(APPEND _wsp_win_link_libs "${_f}")
        endif()
    endforeach()
    target_link_libraries(widespread_wallet_module_plugin PRIVATE
        ${_wsp_win_link_libs})

    # ── .refptr stubs ────────────────────────────────────────────────────────
    # LLVM-emitted objects (our Rust staticlib, and objects inside
    # liblogos_protocol.a) reference .refptr.<sym> without defining it in a
    # linkonce section the way gcc does, and GNU ld does NOT synthesize
    # .refptr symbols (that is an LLD behavior). Emit a stub defining
    # .refptr.<sym> = &<sym>; for dllimport data <sym> resolves to the IAT
    # slot under --enable-auto-import, which is exactly the mechanism the
    # compiler's own linkonce section uses.
    find_program(_wsp_nm NAMES x86_64-w64-mingw32-nm)
    find_program(_wsp_as NAMES x86_64-w64-mingw32-as)
    set(_wsp_refptr_syms "")
    foreach(_lib
            "${CMAKE_CURRENT_SOURCE_DIR}/lib/libwidespread_wallet.a"
            "${CMAKE_CURRENT_SOURCE_DIR}/lib/libwinpthread.a"
            "${LOGOS_PROTOCOL_ROOT}/lib/liblogos_protocol.a")
        if(EXISTS "${_lib}" AND _wsp_nm)
            execute_process(COMMAND "${_wsp_nm}" -u "${_lib}"
                OUTPUT_VARIABLE _undefs ERROR_QUIET)
            string(REGEX MATCHALL "U[ \t]+\\.refptr\\.[A-Za-z0-9_.$]+"
                _ms "${_undefs}")
            foreach(_m IN LISTS _ms)
                string(REGEX REPLACE "^U[ \t]+\\.refptr\\." "" _s "${_m}")
                list(APPEND _wsp_refptr_syms "${_s}")
            endforeach()
        endif()
    endforeach()
    if(_wsp_refptr_syms AND _wsp_as)
        list(REMOVE_DUPLICATES _wsp_refptr_syms)
        set(_wsp_refptr_asm "")
        foreach(_s IN LISTS _wsp_refptr_syms)
            string(APPEND _wsp_refptr_asm
                "\t.section .rdata$.refptr.${_s},\"dr\"\n\t.globl .refptr.${_s}\n\t.align 8\n.refptr.${_s}:\n\t.quad ${_s}\n\n")
        endforeach()
        set(_wsp_refptr_s "${CMAKE_CURRENT_BINARY_DIR}/wsp_refptr_stubs.s")
        set(_wsp_refptr_o "${CMAKE_CURRENT_BINARY_DIR}/wsp_refptr_stubs.o")
        file(WRITE "${_wsp_refptr_s}" "${_wsp_refptr_asm}")
        execute_process(COMMAND "${_wsp_as}" "${_wsp_refptr_s}"
            -o "${_wsp_refptr_o}" RESULT_VARIABLE _as_rc)
        if(_as_rc EQUAL 0 AND EXISTS "${_wsp_refptr_o}")
            list(LENGTH _wsp_refptr_syms _n)
            message(STATUS "widespread_wallet: emitting ${_n} .refptr stubs")
            target_link_libraries(widespread_wallet_module_plugin PRIVATE
                "${_wsp_refptr_o}")
        else()
            message(WARNING "widespread_wallet: .refptr stub assembly failed (rc=${_as_rc})")
        endif()
    endif()
    # --enable-auto-import: objects compiled dllimport-style emit .refptr.*
    # refs that ld only resolves under auto-import.
    target_link_options(widespread_wallet_module_plugin PRIVATE
        -static-libgcc -Wl,--enable-auto-import)
endif()
