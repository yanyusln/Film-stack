package app.local.videoplayer

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.enableEdgeToEdge
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/**
 * 存储权限引导。
 *
 * 为什么非要这段 Kotlin：影栈的核心是「扫描用户指定的目录」，而 Android 11+ 想
 * 把 /storage 当普通文件系统读（扫描走 walkdir、自检走 std::fs、目录浏览走 read_dir），
 * 唯一的途径就是「所有文件的访问权限」（MANAGE_EXTERNAL_STORAGE）。
 * 它**不能**用 requestPermissions 申请——必须把用户送到系统设置页去开关。
 *
 * 不引导的后果很难查：目录选得出来，内容却一个字节都读不到，表现为「一个视频都扫不到」，
 * 看起来像扫描器的 bug，其实是权限。
 */
class MainActivity : TauriActivity() {
  /** 本次进程内是否已经弹过，避免从设置页返回后反复打扰。 */
  private var prompted = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    maybeRequestStorageAccess()
  }

  override fun onRestart() {
    super.onRestart()
    // 用户可能刚从设置页回来：已经给了就不必再提，没给也不纠缠
    if (!hasAllFilesAccess() && !prompted) maybeRequestStorageAccess()
  }

  private fun maybeRequestStorageAccess() {
    if (hasAllFilesAccess()) return
    prompted = true
    MaterialAlertDialogBuilder(this)
      .setTitle("需要「所有文件访问」权限")
      .setMessage("影栈只读取你指定的影片目录，不会修改、移动或删除任何文件。请在下个页面里开启「允许管理所有文件」。")
      .setPositiveButton("去设置") { _, _ -> openAllFilesAccessSettings() }
      .setNegativeButton("以后再说", null)
      .show()
  }

  private fun hasAllFilesAccess(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()

  private fun openAllFilesAccessSettings() {
    val direct = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
      .setData(Uri.parse("package:$packageName"))
    // 部分厂商阉割了针对单个应用的 Intent，退回系统统一的授权列表页，别静默失败
    if (direct.resolveActivity(packageManager) != null) {
      startActivity(direct)
    } else {
      startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
    }
  }
}
