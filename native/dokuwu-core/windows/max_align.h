/* MSVC's C headers do not define max_align_t, but the mupdf crate needs it from
   bindgen. Include this file through BINDGEN_EXTRA_CLANG_ARGS (see README). */
typedef double max_align_t;
