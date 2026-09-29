# Changelog

## v1.0.3 - 2026-09-29

Fixed:
- Whiteboard no longer creates collections on its own. Earlier versions could add empty collections named "Untitled Collection" or extra copies of "Whiteboard sync" to your workspace, most often right after the app started. They are safe to delete: keep only the "Whiteboard sync" collection that holds a record, or delete all of them if you like.

## v1.0.2 - 2026-09-29

Fixed:
- A note card showing a page's whole body no longer says "Block not found" after you delete lines in it. It always shows what the page holds, and an emptied page gets one empty line to write in.
- A note card sent to a page no longer says "Block not found" when its lines are deleted. It shows as an empty card of that page, and Edit gives it a fresh line at the end of the page.
- A new note card no longer flashes "Empty card" for a moment before the editor opens.

## v1.0.1 - 2026-09-29

Fixed:
- A board with a light or dark theme of its own no longer flashes to Thymer's theme when you change tools.
- A board you emptied on purpose no longer reopens with saving paused and "Unsaved changes".
- Esc closes the page picker, and the Page tool stays chosen.
- The delete button says "Remove from board" on cards that show a page, since the page itself is never touched.
- Sending a note card to a page no longer leaves "Container root item disappeared" on the card.
- "New note in a collection" is now two steps: find the collection, then give the page a title (prefilled with the card's first line, which moves into the title).
- The hidden sync collection is only created while the device is in step with the server, so no empty "Untitled Collection" appears.

## v1.0.0 - 2026-09-28

First public release.

- **An infinite canvas** with post-its, sticky stacks, text, shapes (drag to size, or outlines to frame things), frames, images and link cards.
- **Your pages on the board**: any page as Thymer's own board or gallery card with editable properties, and note cards that are a live piece of a page, sent to a page as body content or showing a page's whole body.
- **Mind maps** with horizontal, top-down, org chart and free layouts, branch colours, and branches you can drag, reorder and move between maps.
- **Relations between anything**: curved, straight or elbow, line styles, arrowheads, labels, bends and thickness, and drag-to-empty-space to create the next element.
- **Organising**: align and arrange, stacking order, lock, copy and paste, the Selection menu's "Turn into", sub-boards, comments and tags, minimap and focus mode.
- **Boards everywhere**: a Boards collection with a tile view, boards linked both ways to pages and collections, and palette commands to create and find boards.
- **Live sync between devices**, with changes merged element by element, saving only once a device is in step with the server, local version history, and JSON export and import.
- **Phone support** with touch controls.
