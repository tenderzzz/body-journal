// Run inside the built mobile UI, including WKWebView in a disposable iPhone simulator.
export async function checkRecordForms() {
  const waitFor = async (selector) => {
    for (let i = 0; i < 100; i++) {
      const element = document.querySelector(selector);
      if (element) return element;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error('录入界面未显示 ' + selector);
  };
  for (let i = 0; i < 5; i++) {
    await waitFor('.capture button:nth-child(5)');
    const buttons = [...document.querySelectorAll('.capture button')];
    if (buttons.length !== 5) throw Error('录入入口数量不符');
    const colors = buttons.map((b) => getComputedStyle(b).backgroundColor + '/' + getComputedStyle(b).color);
    if (new Set(colors).size !== 1) throw Error('录入入口应使用相同的常态颜色');
    const name = buttons[i].textContent.trim();
    buttons[i].click();
    await waitFor('form textarea');
    if (name === '记步数') {
      const today = [...document.querySelectorAll('.step-dates button')].find((b) => b.textContent === '今天');
      today.click();
      await waitFor("form input[type='time']");
    }
    const text = document.querySelector('form textarea').getBoundingClientRect();
    const fields = [
      ...document.querySelectorAll(
        "form input[type='datetime-local'], form input[type='date'], form input[type='time']",
      ),
    ];
    if (!fields.length) throw Error(name + '缺少日期控件');
    for (const field of fields) {
      const native = field.getBoundingClientRect();
      const frame = (field.closest('.record-date-field') ?? field).getBoundingClientRect();
      if (
        Math.abs(frame.left - text.left) > 1 ||
        Math.abs(frame.right - text.right) > 1 ||
        native.left < frame.left - 1 ||
        native.right > frame.right + 1 ||
        native.width < frame.width - 28 ||
        frame.height < 44 ||
        document.documentElement.scrollWidth > innerWidth
      ) {
        throw Error(
          name +
            '的日期控件与正文边界不齐 ' +
            JSON.stringify([native.x, native.width, frame.x, frame.width, text.x, text.width]),
        );
      }
    }
    document.querySelector('button.back').click();
  }
  await waitFor('.capture');
}
