// The Make task sheet (Tasks window): the repository, up to three images, then
// a confirmation. Each image is sent first, one at a time, and the task names
// the ids the server kept for them; the agent gets the images beside the task.

const IMAGE_LIMIT = 3; // MAX_IMAGES in ai_dashboard/agent_actions.py
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // MAX_IMAGE_BYTES there
const IMAGE_UPLOAD_TIMEOUT_MS = 60 * 1000; // UPLOAD_TIMEOUT_SECONDS in server.py

let taskImages = []; // { file, url } picked for the draft in taskImagesDraft
let taskImagesDraft = null; // the taskDraft those images were picked for
let imagesSending = false; // true while the images of a task are uploading

// The images of the current draft; a new draft starts with none.
function draftImages() {
  if (taskImagesDraft !== taskDraft) {
    clearDraftImages();
    taskImagesDraft = taskDraft;
  }
  return taskImages;
}

function clearDraftImages() {
  for (const image of taskImages) URL.revokeObjectURL(image.url);
  taskImages = [];
}

// Keeps the picked files that fit; says why one was skipped.
function addImages(files) {
  addImagesTo(draftImages(), files);
}

// Adds the files that fit to images (a draft's list), up to IMAGE_LIMIT.
function addImagesTo(images, files) {
  for (const file of files) {
    if (images.length >= IMAGE_LIMIT) {
      actionNotice = { text: `A task takes up to ${IMAGE_LIMIT} images.`, until: Date.now() + NOTICE_MS };
      break;
    }
    if (!file.type.startsWith("image/")) {
      actionNotice = { text: `${file.name} is not an image.`, until: Date.now() + NOTICE_MS };
    } else if (file.size > IMAGE_MAX_BYTES) {
      actionNotice = { text: `${file.name} is larger than 5 MB.`, until: Date.now() + NOTICE_MS };
    } else {
      images.push({ file, url: URL.createObjectURL(file) });
    }
  }
}

function imagePicker(disabled, onFiles = addImages) {
  const input = el("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.disabled = disabled;
  input.setAttribute("aria-label", "Images for the task");
  input.addEventListener("change", () => {
    onFiles([...input.files]);
    refresh();
  });
  const label = el("label", "Add images", "row-button image-pick");
  label.append(input);
  return label;
}

// The preview and the file name, the name rendered as text only.
function imagePreview(image, index, images = taskImages) {
  const figure = el("figure", null, "task-image");
  const picture = el("img", null, "task-image-preview");
  picture.src = image.url;
  picture.alt = `Image ${index + 1}`;
  const remove = taskButton("Remove image", `task:image:${images === taskImages ? "" : "work:"}${index}`, "row-button work-secondary", () => {
    URL.revokeObjectURL(image.url);
    images.splice(index, 1);
    refresh();
  });
  remove.disabled = remove.disabled || imagesSending;
  figure.append(picture, el("figcaption", image.file.name, "card-note"), remove);
  return figure;
}

// Sends one image; resolves with its upload id. Gives up after a minute, so a
// connection that never answers cannot hold the sheet.
async function uploadImage(file) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_UPLOAD_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("image", file, file.name);
    const response = await fetch("/api/coding/images", {
      method: "POST",
      headers: { Authorization: "tma " + (tg ? tg.initData : "") },
      body: form,
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await readJson(response);
    if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
    if (!body || typeof body.id !== "string") throw new Error("the server sent an unreadable answer");
    return body.id;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`no answer within ${IMAGE_UPLOAD_TIMEOUT_MS / 1000} s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Uploads in order and resolves with the ids; rejects at the first failure.
async function uploadImages(images) {
  const ids = [];
  for (const image of images) ids.push(await uploadImage(image.file));
  return ids;
}

// The Make task sheet. Autopilot tasks take no images: the server's
// create_autopilot_task has no images field, so they are refused here.
function makeTaskCard(setup) {
  const projects = setup.projects.map((project) => ({ value: project.name, note: project.repository }));
  if (!taskRepo || !projects.some((option) => option.value === taskRepo)) {
    const active = setup.projects.find((project) => project.active);
    taskRepo = active ? active.name : "";
  }
  const repos = radioList("task-repo", projects, taskRepo, hasPendingActions(), (name) => { taskRepo = name; });
  const images = draftImages();
  const imagesBox = el("div", null, "task-images");
  const limit = `Up to ${IMAGE_LIMIT} images, ${IMAGE_MAX_BYTES / (1024 * 1024)} MB each.`;
  imagesBox.append(imagePicker(imagesSending || hasPendingActions()), ...images.map(imagePreview), el("div", limit, "card-note"));
  const make = taskButton("Make task and plan", "task:create", "row-button", (button) => {
    if (!taskRepo) {
      showAlert("Choose the repository first.");
      return;
    }
    const draft = taskDraft;
    const repo = taskRepo;
    const autopilot = taskAutopilot;
    const text = draft.text.replace(/\s+/g, " ").trim().slice(0, WORK_TEXT_LIMIT);
    const picked = [...draftImages()];
    if (autopilot && picked.length) {
      showAlert("Autopilot tasks take no images. Remove them or untick Autopilot.");
      return;
    }
    button.disabled = true;
    const withImages = picked.length ? ` with ${picked.length} image${picked.length === 1 ? "" : "s"}` : "";
    const mode = autopilot ? "Make an Autopilot task" : "Make a task";
    askConfirmation(`${mode} in ${repo}${withImages} and start planning it${plannerText()}? This uses AI tokens.`, async (isConfirmed) => {
      if (!isConfirmed) {
        button.disabled = false;
        return;
      }
      let ids = [];
      if (picked.length) {
        imagesSending = true;
        refresh();
      }
      try {
        ids = await uploadImages(picked);
      } catch (error) {
        imagesSending = false;
        actionNotice = { text: `Image not sent: ${error.message}`, until: Date.now() + NOTICE_MS };
        refresh();
        return;
      }
      imagesSending = false;
      if (taskDraft !== draft) return;  // cancelled while the images were sent
      const done = (result) => {
        taskDraft = null;
        clearDraftImages();
        taskFilter = "active";
        actionNotice = { text: result.message, until: Date.now() + NOTICE_MS };
      };
      if (autopilot) {
        requestAction("task:create", "create_autopilot_task", { repo, text, todo: draft.todo }, done);
      } else {
        requestAction("task:create", "create_task", { repo, text, todo: draft.todo, images: ids.join(",") }, done);
      }
    });
  });
  make.disabled = make.disabled || imagesSending;
  if (imagesSending) make.textContent = "Sending images…";
  const cancel = taskButton("Cancel", "task:cancel", "row-button work-secondary", () => {
    taskDraft = null;
    refresh();
  });
  const sheet = card("Make a task", el("p", taskDraft.text, "plan-summary"), el("div", "Repository", "card-subtitle"), repos,
    autopilotBox(), imagesBox, workActions(make, cancel), el("div", "If another task is planning, this one waits as To do.", "card-note"));
  sheet.classList.add("card-wide", "task-sheet");
  return sheet;
}
