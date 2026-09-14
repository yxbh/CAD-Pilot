---
name: visual-review
description: 'Co-design CAD with a non-CAD user. Use for unclear shape preferences, pointing at an edge or surface, annotated screenshots, geometry references, before/after comparisons, or difficulty describing a design change.'
---

# Visual Co-Design

1. Open the actual project's model in CAD Explorer, not an unrelated prior artifact. Report the model path and revision. Preserve the camera across comparisons whenever possible.
2. Use plain words: opening, rim, rounded edge, wall, attachment point. The user does not need to learn CAD terminology to express a preference.
3. Accept a copied `@cad[...]` reference, a circled screenshot, a sketch, a reference photo, or prose. A screen location is not a world coordinate, and a photo does not establish real-world dimensions without a scale reference.
4. Before an ambiguous edit, show the selected region or a labeled screenshot and ask whether it is the intended target. If the user is unsure about the shape, offer two rough alternatives instead of demanding a technical name.
5. For feedback worth keeping across sessions, save the relevant screenshot/reference, model revision, intended change, and what must stay fixed in the project's existing notes. Include the camera/view when needed to interpret a mark. Do not require a separate review form or log every interaction. Preserve existing layouts; do not invent selections or claim you saw an uninspected view.
6. Edit the smallest responsible source feature. Regenerate, inspect geometry, and show before/after views. Re-resolve geometry references after regeneration; face numbers and even semantic selectors can change or become ambiguous.
7. Ask for approval of the overall shape before finishing cosmetic details. Keep aesthetic approval separate from dimensional, print, and safety checks.

## Current Tool Boundary

CAD Explorer offers face selection, copied geometry references, draw mode, and screenshot controls. Pass references and screenshots through chat; there is no live chat-selection bridge. Verify that any annotation is present in the actual shared image. Never imply the agent sees live selections without reading actual tool output.