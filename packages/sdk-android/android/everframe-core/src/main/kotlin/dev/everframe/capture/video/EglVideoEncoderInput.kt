// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.EGLExt
import android.opengl.GLES20
import android.opengl.GLUtils
import android.view.Surface
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Measured alternative only. One accepted bitmap upload, context, texture and codec Surface; no window Surface. */
internal class EglVideoEncoderInput(private val timings:VideoEncoderTimings):VideoEncoderInput {
    private var thread:Thread?=null
    private var size:VideoSize?=null
    private var codecSurface:Surface?=null
    private var display:EGLDisplay=EGL14.EGL_NO_DISPLAY
    private var context:EGLContext=EGL14.EGL_NO_CONTEXT
    private var surface:EGLSurface=EGL14.EGL_NO_SURFACE
    private var texture=0
    private var program=0
    private var position=-1
    private var coordinates=-1
    private val vertices=ByteBuffer.allocateDirect(16*4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
        // Bitmap first row is the top: invert texture v, not the presentation geometry.
        put(floatArrayOf(-1f,-1f,0f,1f, 1f,-1f,1f,1f, -1f,1f,0f,0f, 1f,1f,1f,0f));position(0)
    }
    private fun checkThread() {check(Thread.currentThread() === thread)}
    override fun configure(format:MediaFormat,size:VideoSize):Boolean {
        check(thread == null || Thread.currentThread() === thread)
        thread=Thread.currentThread();this.size=size
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT,MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        return true
    }
    override fun onCodecConfigured(codec:MediaCodec):Boolean {
        checkThread()
        codecSurface=codec.createInputSurface()
        display=EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        check(display != EGL14.EGL_NO_DISPLAY)
        val versions=IntArray(2)
        check(EGL14.eglInitialize(display,versions,0,versions,1))
        val configs=arrayOfNulls<EGLConfig>(1);val count=IntArray(1)
        val attributes=intArrayOf(EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,
            EGL14.EGL_ALPHA_SIZE,8,EGL14.EGL_RENDERABLE_TYPE,EGL14.EGL_OPENGL_ES2_BIT,
            EGL14.EGL_SURFACE_TYPE,EGL14.EGL_WINDOW_BIT,0x3142,1,EGL14.EGL_NONE) // EGL_RECORDABLE_ANDROID
        check(EGL14.eglChooseConfig(display,attributes,0,configs,0,1,count,0) && count[0]>0)
        val config=checkNotNull(configs[0])
        context=EGL14.eglCreateContext(display,config,EGL14.EGL_NO_CONTEXT,intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION,2,EGL14.EGL_NONE),0)
        check(context != EGL14.EGL_NO_CONTEXT)
        surface=EGL14.eglCreateWindowSurface(display,config,codecSurface,intArrayOf(EGL14.EGL_NONE),0)
        check(surface != EGL14.EGL_NO_SURFACE)
        check(EGL14.eglMakeCurrent(display,surface,surface,context))
        program=linkProgram()
        position=GLES20.glGetAttribLocation(program,"position")
        coordinates=GLES20.glGetAttribLocation(program,"coordinates")
        check(position>=0 && coordinates>=0)
        val textures=IntArray(1);GLES20.glGenTextures(1,textures,0);texture=textures[0];check(texture!=0)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D,texture)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_MIN_FILTER,GLES20.GL_NEAREST)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_MAG_FILTER,GLES20.GL_NEAREST)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_WRAP_S,GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_WRAP_T,GLES20.GL_CLAMP_TO_EDGE)
        val target=checkNotNull(size)
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D,0,GLES20.GL_RGBA,target.width,target.height,0,GLES20.GL_RGBA,GLES20.GL_UNSIGNED_BYTE,null)
        checkGl()
        return true
    }
    override fun submit(codec:MediaCodec,frame:SafeVideoFrame,ptsUs:Long):Boolean {
        checkThread()
        if(!frame.isAuthorized()) return false
        val target=checkNotNull(size)
        check(EGL14.eglMakeCurrent(display,surface,surface,context))
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);GLES20.glBindTexture(GLES20.GL_TEXTURE_2D,texture)
        val uploadStart=System.nanoTime()
        if(!frame.withPixels { bitmap ->
            check(bitmap.width==target.width && bitmap.height==target.height)
            GLUtils.texSubImage2D(GLES20.GL_TEXTURE_2D,0,0,0,bitmap)
        }) return false
        checkGl();timings.textureUploadNs.add(System.nanoTime()-uploadStart)
        if(!frame.isAuthorized()) return false
        val submissionStart=System.nanoTime()
        GLES20.glViewport(0,0,target.width,target.height)
        GLES20.glDisable(GLES20.GL_BLEND)
        GLES20.glUseProgram(program)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(program,"pixels"),0)
        vertices.position(0);GLES20.glVertexAttribPointer(position,2,GLES20.GL_FLOAT,false,16,vertices)
        vertices.position(2);GLES20.glVertexAttribPointer(coordinates,2,GLES20.GL_FLOAT,false,16,vertices)
        GLES20.glEnableVertexAttribArray(position);GLES20.glEnableVertexAttribArray(coordinates)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP,0,4)
        checkGl()
        // Only the synthetic/accepted bitmap texture reaches this surface. No PixelCopy/window surface binds here.
        if(!frame.isAuthorized()) return false
        check(EGLExt.eglPresentationTimeANDROID(display,surface,ptsUs*1_000))
        check(EGL14.eglSwapBuffers(display,surface))
        timings.inputSubmissionNs.add(System.nanoTime()-submissionStart)
        return true
    }
    override fun signalEndOfInput(codec:MediaCodec) {checkThread();codec.signalEndOfInputStream()}
    override fun close() {
        if(thread == null) return
        checkThread()
        try {
            if(display != EGL14.EGL_NO_DISPLAY) {
                if(context != EGL14.EGL_NO_CONTEXT && surface != EGL14.EGL_NO_SURFACE &&
                    EGL14.eglMakeCurrent(display,surface,surface,context)) {
                    if(texture!=0)GLES20.glDeleteTextures(1,intArrayOf(texture),0)
                    if(program!=0)GLES20.glDeleteProgram(program)
                }
                EGL14.eglMakeCurrent(display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT)
                if(surface != EGL14.EGL_NO_SURFACE)EGL14.eglDestroySurface(display,surface)
                if(context != EGL14.EGL_NO_CONTEXT)EGL14.eglDestroyContext(display,context)
                EGL14.eglReleaseThread();EGL14.eglTerminate(display)
            }
        } finally {
            codecSurface?.release();codecSurface=null;texture=0;program=0;size=null
            display=EGL14.EGL_NO_DISPLAY;surface=EGL14.EGL_NO_SURFACE;context=EGL14.EGL_NO_CONTEXT
            vertices.clear() // Static geometry contains no captured pixels.
            thread=null
        }
    }
    private fun checkGl(){check(GLES20.glGetError()==GLES20.GL_NO_ERROR)}
    private fun shader(type:Int,source:String):Int {
        val shader=GLES20.glCreateShader(type);check(shader!=0)
        try {
            GLES20.glShaderSource(shader,source);GLES20.glCompileShader(shader)
            val status=IntArray(1);GLES20.glGetShaderiv(shader,GLES20.GL_COMPILE_STATUS,status,0)
            check(status[0]!=0){GLES20.glGetShaderInfoLog(shader)}
            return shader
        } catch(t:Throwable){GLES20.glDeleteShader(shader);throw t}
    }
    private fun linkProgram():Int {
        val vertex=shader(GLES20.GL_VERTEX_SHADER,"attribute vec2 position; attribute vec2 coordinates; varying vec2 uv; void main(){gl_Position=vec4(position,0.0,1.0);uv=coordinates;}")
        var fragment=0;var linked=0
        try {
            fragment=shader(GLES20.GL_FRAGMENT_SHADER,"precision mediump float; varying vec2 uv; uniform sampler2D pixels; void main(){gl_FragColor=texture2D(pixels,uv);}")
            linked=GLES20.glCreateProgram();check(linked!=0)
            GLES20.glAttachShader(linked,vertex);GLES20.glAttachShader(linked,fragment);GLES20.glLinkProgram(linked)
            val status=IntArray(1);GLES20.glGetProgramiv(linked,GLES20.GL_LINK_STATUS,status,0)
            check(status[0]!=0){GLES20.glGetProgramInfoLog(linked)}
            return linked
        } catch(t:Throwable){if(linked!=0)GLES20.glDeleteProgram(linked);throw t}
        finally {GLES20.glDeleteShader(vertex);if(fragment!=0)GLES20.glDeleteShader(fragment)}
    }
}
