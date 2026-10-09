# Third-party packages

The packages this project depends on directly at run time, with the version installed by `npm ci` and the license each one declares in its own `package.json`. This list is generated from that installed metadata. It does not include the packages those depend on, or the tools used only for building and testing. Read each package's own license text in `node_modules/<package>/` for the full terms.

The fonts are bundled with the app so the page asks no other host for them.

## Server (`server/`)

| Package | Version | License |
|---|---|---|
| @google/generative-ai | 0.21.0 | Apache-2.0 |
| @modelcontextprotocol/sdk | 1.32.1 | MIT |
| dotenv | 16.6.1 | BSD-2-Clause |
| express | 4.22.3 | MIT |
| qrcode-generator | 2.0.4 | MIT |
| zod | 3.25.76 | MIT |

## Web app (`web/`), bundled into the page

| Package | Version | License |
|---|---|---|
| @fontsource-variable/figtree | 5.3.0 | OFL-1.1 |
| @fontsource-variable/fraunces | 5.3.0 | OFL-1.1 |
| @fontsource-variable/hanken-grotesk | 5.3.0 | OFL-1.1 |
| @fontsource-variable/newsreader | 5.3.0 | OFL-1.1 |
| @fontsource-variable/plus-jakarta-sans | 5.3.0 | OFL-1.1 |
| @fontsource-variable/source-sans-3 | 5.3.0 | OFL-1.1 |
| @fontsource-variable/spline-sans-mono | 5.3.0 | OFL-1.1 |
| react | 18.3.1 | MIT |
| react-dom | 18.3.1 | MIT |

OFL-1.1 is the SIL Open Font License, version 1.1. It is not the same license as the rest of the list; each font package has its own `LICENSE` file in `node_modules/@fontsource-variable/<name>/`. This project's own code is under the MIT license in [LICENSE](../LICENSE).
