import { createRouter, createWebHashHistory } from "vue-router";

// 仅 createWebHashHistory：无服务端、侧载、各端同源（技术方案 §3.3 / §4.1）。
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      name: "home",
      component: () => import("@/views/HomeView.vue"),
    },
    {
      path: "/player",
      name: "player",
      component: () => import("@/views/PlayerView.vue"),
    },
    {
      path: "/groups",
      name: "groups",
      component: () => import("@/views/GroupsView.vue"),
    },
    {
      path: "/settings",
      name: "settings",
      component: () => import("@/views/SettingsView.vue"),
    },
  ],
});

export default router;
