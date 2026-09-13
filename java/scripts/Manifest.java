import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.stream.Stream;

/** Writes manifest.json for every regular file under the output directory. Run with {@code java Manifest.java <dir> <version>}. */
public final class Manifest {
    private Manifest() {
    }

    public static void main(String[] args) throws IOException, NoSuchAlgorithmException {
        Path root = Path.of(args[0]).toRealPath();
        List<Path> files;
        try (Stream<Path> walk = Files.walk(root)) {
            files = walk.filter(path -> !Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS))
                    .filter(path -> !path.getFileName().toString().equals("manifest.json"))
                    .sorted((left, right) -> relative(root, left).compareTo(relative(root, right)))
                    .toList();
        }
        StringBuilder json = new StringBuilder("{\n  \"schema_version\": 1,\n  \"language\": \"java\",\n  \"version\": \"")
                .append(args[1]).append("\",\n  \"artifacts\": [\n");
        for (int index = 0; index < files.size(); index++) {
            Path file = files.get(index);
            if (Files.isSymbolicLink(file) || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("artifact is not a regular file: " + relative(root, file));
            }
            byte[] bytes = Files.readAllBytes(file);
            String sha256 = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            json.append("    {\"path\": \"").append(relative(root, file)).append("\", \"sha256\": \"").append(sha256)
                    .append("\", \"size_bytes\": ").append(bytes.length).append(index + 1 < files.size() ? "},\n" : "}\n");
        }
        json.append("  ]\n}\n");
        Path temporary = Files.createTempFile(root, ".manifest-", ".tmp");
        Files.writeString(temporary, json, StandardCharsets.UTF_8);
        Files.move(temporary, root.resolve("manifest.json"), StandardCopyOption.ATOMIC_MOVE);
    }

    private static String relative(Path root, Path file) {
        return root.relativize(file).toString().replace('\\', '/');
    }
}
