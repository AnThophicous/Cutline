# Cutline Android

O APK usa Capacitor e leva o frontend para dentro do celular. O processamento local usa `@ffmpeg/ffmpeg` + `@ffmpeg/core` (FFmpeg compilado para WebAssembly). Smart Cut e concatenação rodam no aparelho; o servidor LAN é usado como fallback no desktop.

O core FFmpeg fica no bundle do app. O Whisper.cpp fica em um chunk separado e o modelo quantizado é baixado uma vez, com cache local, somente quando a transcrição é ativada e o WebView oferece memória compartilhada. Em aparelhos com 8 GB ou mais e CPU adequada, o perfil sugere `small-q5_1`; nos demais, `tiny-q5_1`.

O workflow `.github/workflows/android.yml` gera um APK `release` sem assinatura no GitHub Actions com Node 22, Java 21 e Android SDK. Para distribuição instalada em vários aparelhos, configure uma keystore persistente nos secrets do GitHub.

O app não envia vídeo para a DeepSeek. A chave fica no armazenamento local e o usuário precisa autorizar explicitamente o envio das transcrições para gerar headlines. A auditoria da sessão mostra importação, análise, render e consentimento. A transcrição local pode ser bloqueada por WebViews sem `crossOriginIsolated`; nesse caso o app informa o motivo em Configurações, sem fingir que o Whisper está ativo.
