// 右键菜单项（W3-3c）：技术方案 §8.4 要求 PC 右键提供「添加/移除/新建分组」。
// key 用于在父组件里回填动作；danger 表示破坏性操作（粉字）。
export interface MenuItem {
  key: string;
  label: string;
  run?: () => void;
  disabled?: boolean;
  danger?: boolean;
}
