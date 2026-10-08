// Coding › Work card: a bug report the agent has questions about. Shows the
// questions and sends the answer to the agent's /answer; more questions or
// the bugfix plan follow in the bot chat and on this card.

let answerDraft = "";  // kept across refreshes until the agent accepts it

function sendAnswerButton() {
  return workButton("Send answer", "work:answer", "row-button", (button) => {
    const text = answerDraft.replace(/\s+/g, " ").trim().slice(0, WORK_TEXT_LIMIT);
    if (!text) {
      showAlert("Write your answer first.");
      return;
    }
    confirmedWork("Send this answer? The agent checks the report again, which uses AI tokens.",
      "work:answer", "answer_bugfix", { text }, button, (result) => {
        answerDraft = "";
        actionNotice = { text: `${result.message} The result will arrive in the bot chat.`, until: Date.now() + NOTICE_MS };
      });
  });
}

function bugfixRows(snapshot) {
  const pending = snapshot.bugfix_questions;
  const cancel = cancelButton("the pending bugfix");
  if (!pending) {  // an agent that does not publish the questions
    return [row("Bugfix", "waiting for your answer"), el("div", "Answer in the bot chat with /answer.", "card-note"),
      workActions(cancel)];
  }
  const answer = el("textarea", null, "work-draft");
  answer.placeholder = "Your answer…";
  answer.maxLength = WORK_TEXT_LIMIT;
  answer.value = answerDraft;
  answer.disabled = hasPendingActions() || isWorkBusy;
  answer.setAttribute("aria-label", "Answer to the bugfix questions");
  answer.addEventListener("input", () => { answerDraft = answer.value; });
  return [
    row("Bugfix", "needs more detail"),
    el("div", pending.bug, "card-note bugfix-report"),
    el("div", "Questions", "card-subtitle"),
    el("p", pending.questions, "bugfix-questions"),
    answer,
    workActions(sendAnswerButton(), cancel),
  ];
}
