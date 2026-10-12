@echo off
rem Rebuilds DD2SaveManager.exe with the C# compiler that ships with Windows, and puts the
rem WebView2 files it loads at run time into bin\. Close the program first: Windows does not
rem let a running exe be replaced. The compiler options are in build.rsp.
cd /d "%~dp0.."
if not exist bin mkdir bin
copy /y launcher\webview2\Microsoft.Web.WebView2.Core.dll bin\ >nul 2>nul
copy /y launcher\webview2\Microsoft.Web.WebView2.WinForms.dll bin\ >nul 2>nul
copy /y launcher\webview2\WebView2Loader.dll bin\ >nul 2>nul
set "OUT=%~1"
if "%OUT%"=="" set "OUT=DD2SaveManager.exe"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" "/out:%OUT%" @launcher\build.rsp
if errorlevel 1 if "%~1"=="" pause
