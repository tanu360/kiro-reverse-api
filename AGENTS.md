# Engineering principles

Every change to this project, by a person or an agent, follows these rules.

1. **No backward compatibility.** Delete outdated code outright. No compatibility layers, no migration scripts, no backup or fallback paths.
2. **Simplest implementation that meets current needs.** No speculative abstractions, and no configuration layers added "just in case we need them later".
3. **Grow in layers.** Get a minimal end-to-end version working first, then add to it once it runs. Never tear down something that works because of complexity that might arise later.
4. **Modular components, clear separation of concerns.**
5. **Prefer mature, maintained third-party libraries.** Do not rewrite one yourself unless there is a compelling reason.
6. **Check existing dependencies first.** Before adding a package or writing your own code, look at what the project's current dependencies already do. Do not assume a library lacks a feature without checking.
7. **Decide architecture for the long term.** No "make it work for now and deal with it later" stopgaps.
8. **Follow proven patterns.** Look at how mature products solve the same problem and use their patterns instead of inventing new ones.
