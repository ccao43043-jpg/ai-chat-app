package com.aichat.app.plugins.js

/** 读 JS 对象字段的简写（缺键 / undefined → null） */
@Suppress("UNCHECKED_CAST")
operator fun Any?.get(k: String): Any? = (this as? Map<String, Any?>)?.get(k)?.let { if (it === Undefined) null else it }
@Suppress("UNCHECKED_CAST")
fun Any?.o(): JObj? = this as? JObj
@Suppress("UNCHECKED_CAST")
fun Any?.a(): JArr? = this as? MutableList<Any?>
fun Any?.d(): Double = Js.toNumber(this)
fun Any?.i(): Int = Js.toNumber(this).let { if (it.isNaN()) 0 else it.toInt() }
fun Any?.truthy(): Boolean = Js.truthy(this)
/** String(x) */
fun Any?.jstr(): String = Js.str(this)
/** 本身是否 JS 字符串 */
fun Any?.isStr(): Boolean = this is String

/** 带非枚举属性 __orig 的消息对象（JSON.stringify / Object.assign 都不会带上它） */
class OrigMsg(src: Map<String, Any?>, val orig: String) : LinkedHashMap<String, Any?>(src)
/** m.__orig != null ? m.__orig : m.content */
fun origOrContent(m: Any?): Any? = (m as? OrigMsg)?.orig ?: m["content"]
