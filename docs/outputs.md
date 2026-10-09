# Outputs: copying and downloading what the agent wrote

Code blocks in the agent's replies have **Copy** and **Download** buttons. Once a room has at least one, an **Outputs** tab appears next to the conversation and lists them, newest first.

## What counts

Only fenced blocks (a line starting with three backticks) in the agent's replies. Messages from people and comments never appear in Outputs, and empty blocks are left out.

## Names

A block is named from the text after its opening backticks:

- a file name, as in ` ```main.py ` or ` ```js:src/app.js ` or ` ```python title=a.py `, gives that name (only the last part of a path is kept)
- a language, as in ` ```python `, gives `output-<reply>-<n>.py`, where `<n>` is its place among the reply's blocks
- nothing gives `output-<reply>-<n>.txt`

Whatever the text says, the saved name is made only of letters, digits, dots, dashes and underscores; paths and anything else become `_`; leading dots are dropped; a name that Windows reserves (like `CON`) gets an underscore in front; it is cut to 80 characters and keeps its extension. Names that a browser would draw or run when opened (`.html`, `.htm`, `.xhtml`, `.svg`, `.xml`, `.mhtml`, `.hta`) get `.txt` added.

## What it never does

- It never runs, opens, previews as a page or renders what it downloads. A download is handed to the browser as plain text (`text/plain`) and saved; Multiplayer AI doesn't open it.
- It never treats a block's text, or its label, as markup. They are shown as text (the reply renderer builds elements, not HTML), so a block that contains a script tag or a broken tag shows those characters.

## Bounds

- A block longer than 1,000,000 characters is shown in the conversation but its Copy and Download are off, with a note saying why.
- The Outputs tab lists the newest 200 and says "Showing the newest 200 of N" when there are more. Each entry shows a preview of at most 4 lines and 240 characters, not the whole block.
- A single reply with thousands of blocks is read in a few milliseconds; the tests check 8,000.

## Where it is tested

`server/test/outputs-lib.test.js` (names, labels, ordering, bounds, the download call) and `web/qa/outputs.spec.js` (copy and download in a browser, hostile names and contents, the tab, keyboard, huge and many blocks, a 360 px screen, and axe in every theme and mode). Not tested: copying on a browser that forbids the clipboard without a click (it falls back to selecting the text and says so if that fails too), and other browsers than the one the tests use.

## Tables and links in replies

The reply renderer is hand-written and builds elements, never HTML from text. It draws simple tables (a header row, a separator row, then rows; at most 200 rows and 20 columns, with a note saying how much was cut) and links written in Markdown's usual form, the text in square brackets followed by the address in round brackets. A link is made only for a full `http` or `https` address with a host, no user name or password and no space or control character, under 2000 characters; it opens in a new tab with `rel="noopener noreferrer nofollow"`, and the full address is its hover text. Anything else (`javascript:`, `data:`, `file:`, relative or scheme-less addresses) stays text. Images are never drawn: the same form with a leading exclamation mark stays text, and so does raw HTML. Cells and link text are text too.

## Saving the conversation, and the files

Both are made in the browser, from what the page already holds. Nothing is sent anywhere and no address serves them.

**The conversation as Markdown.** "Save conversation as Markdown" above the conversation downloads a `.md` file named from the room's title (made of letters, digits, dots, dashes and underscores). It lists the task, the host's brief if there is one, and every message in order, with who said it. Comments are labelled "comment, not seen by the agent". Every message body is put in a fenced block whose fence is longer than any run of backticks inside it, so nothing a person or the agent wrote can close the block, make a heading, a link, an image or HTML. The few things written outside a fence (the title, a person's name) have every Markdown and HTML special character escaped. Control characters, text-direction marks and zero-width characters are replaced by visible escapes such as `\u{202e}`. File contents are not part of it.

**The room's files as a zip.** On the Files tab, "Download all as a zip" fetches each file the usual way (a POST with the person's token in the body, never in an address) and builds the archive in the browser. The zip writer is written by hand, stores every file uncompressed, and has no dependency. Names inside the archive are cut down to the last part of any path, to letters, digits, dot, dash and underscore, with no leading dot; a name a browser would draw (`.html`, `.svg`) gets `.txt` added; names Windows reserves are changed; and two names that end up the same ignoring case are kept apart. An archive can therefore only unpack to plain files in one folder. It was checked with `unzip -t` and by extracting every file and comparing the bytes. Only the newest version of each file is included.
