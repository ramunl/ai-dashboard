// The worker's editable Work draft is built by coding-start.js in this tree.
// Update attachments locally: shell refreshes are suppressed during editing.
function codingWorkerAttachments(draft, disabled) {
  const preview = attachmentPreview(workImages, disabled);
  const add = (files) => {
    addImagesTo(workImages, files, false);
    preview.render();
  };
  draft.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])]
      .filter((file) => file.type.startsWith("image/"));
    if (!files.length || disabled) return;
    event.preventDefault();
    add(files);
  });
  const controls = el("div", null, "task-images work-images");
  const picker = imagePicker(disabled, add);
  // Files live in workImages; reset the native input so re-picking a removed
  // file fires change too. The upload still consumes the original File objects.
  picker.querySelector("input").addEventListener("change", (event) => {
    event.target.value = "";
  });
  controls.append(picker, el("div",
    "Up to 3 images, 5 MB each. With images, Plan or Implement makes a task in the active project.",
    "card-note"));
  return [preview.node, controls];
}
