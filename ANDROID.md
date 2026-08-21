# Cutline Android

O APK usa Capacitor e leva o frontend para dentro do celular. O processamento local usa `@ffmpeg/ffmpeg` + `@ffmpeg/core` (FFmpeg compilado para WebAssembly), então não depende do servidor, Python, C++ ou internet durante a edição.

O core FFmpeg fica no bundle do app; os vídeos continuam em disco e o processamento é feito em streaming sempre que a operação permitir. O workflow `.github/workflows/android.yml` gera um APK debug no GitHub Actions com Node 22, Java 17 e Android SDK.

Permissões serão solicitadas somente no primeiro uso de importar/exportar: leitura de vídeos e gravação do resultado. O app deve explicar cada permissão antes do prompt nativo e registrar uma auditoria local com data, ação, arquivo e resultado — sem enviar mídia para fora do aparelho.
