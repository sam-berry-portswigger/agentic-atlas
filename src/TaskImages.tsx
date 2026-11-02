import {
  ActionIcon,
  Button,
  FileButton,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { Paperclip, X } from "lucide-react";
export type TaskImage = {
  id?: string;
  name: string;
  data?: string;
  bytes?: number;
  width?: number;
  height?: number;
};
export async function pastedImages(files: File[]): Promise<TaskImage[]> {
  return Promise.all(
    files.map(
      (file) =>
        new Promise<TaskImage>((resolve, reject) => {
          if (file.type !== "image/png" || file.size > 4 * 1024 * 1024) {
            reject(Error("Choose PNG images up to 4 MB each."));
            return;
          }
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              name: file.name || "Pasted image.png",
              data: String(reader.result).split(",")[1],
              bytes: file.size,
            });
          reader.onerror = () => reject(Error("Couldn’t read the PNG image."));
          reader.readAsDataURL(file);
        }),
    ),
  );
}
export default function TaskImages({
  images,
  taskId,
  onChange,
  onFiles,
  loading = false,
}: {
  images: TaskImage[];
  taskId?: string;
  onChange?: (images: TaskImage[]) => void;
  onFiles?: (files: File[]) => void;
  loading?: boolean;
}) {
  if (!images.length && !onChange) return null;
  return (
    <Stack gap="xs" mt="md" component="section" aria-label="Task images">
      <Group justify="space-between">
        <Text size="sm" fw={500}>
          Images{images.length ? ` (${images.length})` : ""}
        </Text>
        {onFiles && (
          <FileButton accept="image/png" multiple onChange={onFiles}>
            {(props) => (
              <Button
                {...props}
                size="xs"
                variant="default"
                loading={loading}
                leftSection={<Paperclip size={13} />}
              >
                Attach PNG
              </Button>
            )}
          </FileButton>
        )}
      </Group>
      {onChange && (
        <Text size="xs" c="dimmed">
          Paste a PNG anywhere in this form, or attach a file. Up to 4 images, 4
          MB each.
        </Text>
      )}
      <div className="td-task-images">
        {images.map((image, index) => {
          const src = image.id
            ? `/api/today/tasks/${encodeURIComponent(taskId || "")}/images/${encodeURIComponent(image.id)}`
            : `data:image/png;base64,${image.data}`;
          return (
            <div className="td-task-image" key={image.id || index}>
              <a
                href={src}
                target="_blank"
                rel="noreferrer"
                title="Open full image"
              >
                <img src={src} alt={image.name} />
              </a>
              <Group gap="xs" justify="space-between" wrap="nowrap">
                <Text size="xs" truncate>
                  {image.name}
                </Text>
                {onChange && (
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label={`Remove image: ${image.name}`}
                    onClick={() =>
                      onChange(images.filter((_, i) => i !== index))
                    }
                  >
                    <X size={14} />
                  </ActionIcon>
                )}
              </Group>
            </div>
          );
        })}
      </div>
    </Stack>
  );
}
