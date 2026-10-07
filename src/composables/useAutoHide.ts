import { onUnmounted, ref } from "vue";

// 控制栏自动隐藏（技术方案 §8.5：3s 无操作后 200ms ease-out 淡出）。
// 视图只关心 visible，定时器收口在这里。
export const AUTO_HIDE_MS = 3000;

export function useAutoHide(delayMs: number = AUTO_HIDE_MS) {
  const visible = ref(true);
  let timer: number | null = null;

  function stop() {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  /** 有交互：重新显示并重启倒计时。 */
  function bump() {
    visible.value = true;
    stop();
    timer = window.setTimeout(() => {
      visible.value = false;
      timer = null;
    }, delayMs);
  }

  function show() {
    visible.value = true;
    stop();
  }

  function hide() {
    visible.value = false;
    stop();
  }

  /** 单击切换显隐：显示后照常走 3s 自动淡出；已显示则立即隐藏。 */
  function toggle() {
    if (visible.value) hide();
    else bump();
  }

  onUnmounted(stop);

  return { visible, bump, show, hide, toggle };
}
