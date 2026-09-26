// msys2-ABI compatibility shim for the Windows cross build.
//
// The circuits bundle's witness objects (pol_local.o, poq_local.o, ...) and
// rapidsnark's fileloader.cpp were built under MSYS2 against a winpthreads/
// msvcrt-flavored libstdc++. nixpkgs' mingw toolchain builds libstdc++ on
// mcfgthread instead, and its libstdc++-6.dll does not export the once-call
// accessors or the (now header-inline) system_error ctor those objects
// reference. The definitions below satisfy the references while delegating
// to the real runtime state, which the DLL still exports as __emutls_v.*
// control objects.
#include <system_error>

namespace std {
// libstdc++ keeps these as __thread globals (emutls under mingw); the DLL
// exports __emutls_v._ZSt11__once_call / __emutls_v._ZSt15__once_callable.
extern __thread void (*__once_call)() noexcept;
extern __thread void* __once_callable;

void*& __get_once_callable() noexcept { return __once_callable; }
void (*&__get_once_call())() noexcept { return __once_call; }
}

// std::system_error is a std::runtime_error base with a single error_code
// member. This shim reproduces the layout; its ctor is reached through a
// jmp thunk emitted under _ZNSt12system_errorC1ESt10error_codePKc in the
// generated stubs object. The vptr is patched to the REAL system_error
// vtable so catch(std::system_error) / RTTI still match.
extern "C" const void* const _ZTVSt12system_error[];

struct WspSysErrorShim : std::runtime_error {
    std::error_code _M_code;
    WspSysErrorShim(std::error_code, const char*);
};

WspSysErrorShim::WspSysErrorShim(std::error_code ec, const char* w)
    : std::runtime_error(w), _M_code(ec)
{
    *reinterpret_cast<const void**>(this) =
        const_cast<const void**>(&_ZTVSt12system_error[2]);
}
