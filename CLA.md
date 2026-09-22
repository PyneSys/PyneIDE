# PyneIDE Contributor License Agreement

**This is not legal advice and it is not a transfer of ownership. You keep the
copyright to everything you write.** What this agreement does is give PYNESYS
LLC permission to use your contribution in PyneIDE *and* in other PyneSys
products, including ones that are not released under the GPL.

## Why it is needed

PyneIDE is released under GPL-3.0-only, and it stays that way. But PyneSys also
builds closed-source products around the same ideas — the PyneComp compiler
today, and a hosted Pyne environment later — and parts of this codebase are
expected to be reused there. The GPL alone does not let PYNESYS LLC do that with
someone else's contribution: the contributor holds the copyright and licensed it
under the GPL only. A single contribution without this agreement would
permanently freeze that part of the code out of any non-GPL product.

If you would rather not agree to this, that is completely fine. Open an issue
instead of a pull request, describe the change or attach a patch, and it can be
reimplemented independently.

## The agreement

By signing, you agree to the following for every contribution you submit to this
repository.

### 1. You keep your copyright

You retain all right, title and interest in your contribution. Nothing here
transfers ownership.

### 2. Copyright license

You grant PYNESYS LLC a perpetual, worldwide, non-exclusive, royalty-free,
irrevocable license to reproduce, modify, prepare derivative works of, publicly
display, publicly perform, sublicense and distribute your contribution and such
derivative works, **under any license terms, including proprietary ones**, and
to relicense it accordingly.

### 3. Patent license

You grant PYNESYS LLC and recipients of software distributed by PYNESYS LLC a
perpetual, worldwide, non-exclusive, royalty-free, irrevocable patent license to
make, have made, use, offer to sell, sell, import and otherwise transfer your
contribution, for patent claims that you own or control and that are necessarily
infringed by your contribution alone or by its combination with the project. If
you initiate patent litigation alleging that the project or a contribution to it
infringes a patent, the patent licenses granted to you under this agreement
terminate.

### 4. The contribution is yours to give

You represent that each contribution is your original work, and that you are
legally entitled to grant the above licenses. If your employer has rights to
work you create, you represent that you have permission to contribute, or that
your employer has waived those rights for this project.

If your contribution contains work that is not yours — third-party code,
generated code carrying its own terms, documentation copied from elsewhere — you
must say so clearly in the pull request, together with its source and license.
Do not submit code derived from TradingView Pine Script community scripts or
from other sources whose license is incompatible with GPL-3.0-only.

### 5. No warranty, no obligation

You provide your contribution "as is", without warranties of any kind, except as
stated above. PYNESYS LLC is not obliged to accept, merge, use or keep any
contribution.

### 6. The GPL still applies to the public project

This agreement is an *additional* grant to PYNESYS LLC. It does not take
anything away from anyone else: your contribution, once merged and released
here, remains available to everyone under GPL-3.0-only, along with the rest of
PyneIDE.

## How to sign

When you open your first pull request, a bot comments on it and the CLA status
check stays red until you sign. To sign, post a comment containing exactly:

```
I have read the CLA Document and I hereby sign the CLA
```

Your signature is recorded in `signatures/version1/cla.json` in this
repository, and it covers that pull request and every later one you submit here.
If the status check does not update, comment `recheck`.

If you are contributing on behalf of a company, an authorized person should sign
on its behalf and say so in the same comment.
